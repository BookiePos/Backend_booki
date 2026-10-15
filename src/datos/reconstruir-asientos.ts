import type { Conteo } from './en-cada-empresa';
import type { LedgerPostingService } from '../modules/core-ledger/application/ledger-posting.service';
import type { OperacionConciliacion } from '../modules/core-ledger/domain/conciliacion';
import { ACC } from '../modules/core-ledger/domain/ledger.constants';
import { fechaColombia } from '../modules/core-ledger/domain/fecha-contable';
import type { CategoryKind } from '../modules/finance/domain/finance.constants';
import { cop, sumBy } from '../modules/finance/domain/money.util';

/**
 * Reconstrucción de asientos faltantes (checklist 1.13).
 *
 * El posteo automático es best-effort: si falla, la venta, el gasto o la
 * compra quedan sin asiento (o un asiento vivo de algo anulado) y el fallo se
 * anota en `ledger_conciliacion_pendientes`. Esto lo repara volviendo a llamar
 * a `LedgerPostingService` con los mismos datos que usó el flujo original, de
 * modo que el asiento sale idéntico. Es idempotente: el índice único del libro
 * (un asiento vivo por origen) impide duplicar, y lo que ya tiene asiento no se
 * toca.
 *
 * Qué arregla solo:
 * - Ventas completadas sin asiento → lo postea.
 *   (En ventas, gastos y recepciones solo se postea lo que NUNCA tuvo asiento
 *   o tiene un pendiente «post»: si el asiento existe pero fue reversado, la
 *   reversa fue a propósito y no se deshace; se cuenta en
 *   `reversadosSinReposteo` para revisarlo.)
 * - Ventas anuladas con asiento vivo → lo reversa.
 * - Gastos sin asiento → lo postea. Asientos vivos de gastos borrados → los
 *   reversa. Gastos con una reversa pendiente (se editó y la reversa falló) →
 *   reversa el viejo y postea el vigente.
 * - Recepciones de compra a crédito sin asiento → lo postea.
 * - Pendientes cuyo asiento ya quedó bien → los marca resueltos.
 *
 * Qué solo cuenta (lo concilia una persona):
 * - Recepciones de contado: la orden no guarda el medio de pago, y adivinar
 *   Caja o Bancos dejaría el libro mal en vez de incompleto.
 * - Recepciones anteriores al `_id` de la recepción: su asiento usaba otro
 *   `sourceId` y no se puede saber si ya existe.
 * - Pendientes de otros orígenes (abonos, devoluciones, nómina).
 */

export const AUTOR = 'datos:reconstruir-asientos';

type Posting = Pick<
  LedgerPostingService,
  'postSale' | 'reverseSale' | 'postExpense' | 'reverseExpense' | 'postPurchaseReceipt'
>;

export interface VentaGuardada {
  id: string;
  saleNumber: string;
  sedeId: string;
  status: string;
  total: number;
  deliveryFee?: number;
  tip?: number;
  paymentMethod: string;
  lines: { taxKind?: string; taxAmount?: number }[];
  components: { cost?: number }[];
  createdAt: Date;
}

export interface GastoGuardado {
  id: string;
  sedeId: string;
  categoryId: string;
  concept: string;
  amount: number;
  taxAmount: number;
  withholdingAmount?: number;
  date: string;
  status: 'paid' | 'payable';
  paymentMethod?: string;
}

export interface OrdenGuardada {
  id: string;
  number: string;
  sedeId: string;
  lines: { qty: number; unitCost: number; taxAmount?: number }[];
  receipts: {
    id?: string;
    date: string;
    payableId?: string;
    lines: { lineIndex: number; qty: number }[];
  }[];
}

export interface PendienteAbierto {
  sourceType: string;
  sourceId: string;
  operacion: OperacionConciliacion;
}

export interface FuentesReconstruccion {
  /** sourceIds con asiento vivo (original sin reversar) de ese tipo. */
  origenesVivos(sourceType: string): Promise<Set<string>>;
  /** sourceIds con asiento original de ese tipo, vivo o reversado. */
  origenesRegistrados(sourceType: string): Promise<Set<string>>;
  ventas(): Promise<VentaGuardada[]>;
  gastos(): Promise<GastoGuardado[]>;
  ordenes(): Promise<OrdenGuardada[]>;
  naturalezaDeCategorias(): Promise<Map<string, CategoryKind>>;
  descuentaIva(): Promise<(sedeId: string) => boolean>;
  pendientes(): Promise<PendienteAbierto[]>;
  resolver(p: PendienteAbierto): Promise<void>;
  posting: Posting;
}

/** Mismo mapeo que `FinanceService.expenseAccountFor` (lo fija un spec). */
export function cuentaDeGasto(kind?: CategoryKind): string | undefined {
  if (kind === 'payroll') return ACC.GASTOS_PERSONAL;
  if (kind === 'cogs') return ACC.COSTO_VENTA;
  return undefined;
}

/** Entrada de `postSale` desde la venta guardada, como la arma `SalesService`. */
export function insumoVenta(v: VentaGuardada): Parameters<Posting['postSale']>[0] | null {
  const total = cop(v.total);
  const deliveryFee = cop(v.deliveryFee ?? 0);
  if (total + deliveryFee <= 0) return null;
  const taxOf = (kind: string) =>
    sumBy(
      v.lines.filter((l) => (l.taxKind ?? 'iva') === kind),
      (l) => l.taxAmount ?? 0,
    );
  return {
    saleId: v.id,
    number: v.saleNumber,
    date: fechaColombia(v.createdAt),
    sedeId: v.sedeId,
    total,
    tax: taxOf('iva'),
    consumptionTax: taxOf('inc'),
    cogs: sumBy(v.components, (c) => c.cost ?? 0),
    deliveryFee,
    tip: cop(v.tip ?? 0),
    paymentMethod: v.paymentMethod,
    onCredit: v.paymentMethod === 'credit',
    userEmail: AUTOR,
  };
}

/** Entrada de `postExpense` desde el gasto guardado, como la arma `FinanceService`. */
export function insumoGasto(
  g: GastoGuardado,
  kind: CategoryKind | undefined,
  descuentaIva: boolean,
): Parameters<Posting['postExpense']>[0] | null {
  if (cop(g.amount) + cop(g.taxAmount) <= 0) return null;
  return {
    expenseId: g.id,
    date: g.date,
    sedeId: g.sedeId,
    amount: g.amount,
    tax: g.taxAmount,
    ivaDescontable: descuentaIva ? g.taxAmount : 0,
    status: g.status,
    paymentMethod: g.paymentMethod,
    expenseAccount: cuentaDeGasto(kind),
    concept: g.concept,
    withholding: g.withholdingAmount ?? 0,
    userEmail: AUTOR,
  };
}

export type RecepcionReconstruida =
  | { tipo: 'postear'; input: Parameters<Posting['postPurchaseReceipt']>[0] }
  | { tipo: 'contado' | 'sinId' | 'vacia'; receiptId: string };

/**
 * Entradas de `postPurchaseReceipt` de cada recepción de la orden, con el mismo
 * cálculo de `PurchasingService.receive`: base `unitCost × qty` y el IVA del
 * renglón repartido por lo acumulado, para que las parciales sumen exacto.
 * Recorre las recepciones en orden porque el IVA de cada una depende de las
 * anteriores.
 */
export function recepcionesDeOrden(
  o: OrdenGuardada,
  descuentaIva: boolean,
): RecepcionReconstruida[] {
  const acumulado = o.lines.map(() => 0);
  return o.receipts.map((r, i) => {
    let valor = 0;
    let iva = 0;
    for (const rl of r.lines) {
      const line = o.lines[rl.lineIndex];
      if (!line) continue;
      acumulado[rl.lineIndex] = (acumulado[rl.lineIndex] ?? 0) + rl.qty;
      const acum = acumulado[rl.lineIndex]!;
      const ivaRenglon = line.taxAmount ?? 0;
      iva +=
        line.qty > 0
          ? cop((ivaRenglon * acum) / line.qty) - cop((ivaRenglon * (acum - rl.qty)) / line.qty)
          : 0;
      valor += cop(line.unitCost * rl.qty);
    }
    const receiptId = r.id ? `${o.id}:${r.id}` : `${o.id}:#${i}`;
    if (!r.id) return { tipo: 'sinId', receiptId };
    if (valor <= 0) return { tipo: 'vacia', receiptId };
    if (!r.payableId) return { tipo: 'contado', receiptId };
    return {
      tipo: 'postear',
      input: {
        receiptId,
        date: r.date,
        sedeId: o.sedeId,
        amount: descuentaIva ? valor : valor + iva,
        ivaDescontable: descuentaIva ? iva : 0,
        onCredit: true,
        number: o.number,
        userEmail: AUTOR,
      },
    };
  });
}

const ORIGENES_CON_HERRAMIENTA: readonly string[] = ['sale', 'expense', 'purchase_receipt'];

/**
 * Cuenta (y con `aplicar`, repara) lo que falta en el libro de la empresa
 * activa. En seco no escribe nada. Tras aplicar, todas las cifras deberían
 * quedar en 0 salvo las que solo se cuentan (`recepcionesContado`,
 * `recepcionesSinId`, `pendientesManuales`).
 */
export async function reconstruirAsientos(
  f: FuentesReconstruccion,
  aplicar: boolean,
): Promise<Conteo> {
  const [ventasVivas, gastosVivos, recepcionesVivas] = await Promise.all([
    f.origenesVivos('sale'),
    f.origenesVivos('expense'),
    f.origenesVivos('purchase_receipt'),
  ]);
  const registrados = new Map(
    await Promise.all(
      ORIGENES_CON_HERRAMIENTA.map(
        async (t) => [t, await f.origenesRegistrados(t)] as const,
      ),
    ),
  );
  const [ventas, gastos, ordenes, kinds, descuenta, pendientes] = await Promise.all([
    f.ventas(),
    f.gastos(),
    f.ordenes(),
    f.naturalezaDeCategorias(),
    f.descuentaIva(),
    f.pendientes(),
  ]);
  const c: Conteo = {
    pendientesAbiertos: pendientes.length,
    ventasSinAsiento: 0,
    ventasAnuladasConAsiento: 0,
    gastosSinAsiento: 0,
    gastosPorRehacer: 0,
    asientosDeGastosBorrados: 0,
    recepcionesSinAsiento: 0,
    recepcionesContado: 0,
    recepcionesSinId: 0,
    pendientesManuales: 0,
    reversadosSinReposteo: 0,
  };
  /** ¿Se puede postear? Nunca tuvo asiento, o quedó un pendiente «post». */
  const debePostear = (sourceType: string, sourceId: string) =>
    !registrados.get(sourceType)!.has(sourceId) ||
    pendientes.some(
      (p) => p.sourceType === sourceType && p.sourceId === sourceId && p.operacion === 'post',
    );

  // 1. Gastos editados cuya reversa falló: el asiento vivo es el viejo.
  const gastoPorId = new Map(gastos.map((g) => [g.id, g]));
  const rehechos = new Set<string>();
  for (const p of pendientes) {
    if (p.sourceType !== 'expense' || p.operacion !== 'reverse') continue;
    if (!gastoPorId.has(p.sourceId) || !gastosVivos.has(p.sourceId)) continue;
    c.gastosPorRehacer!++;
    rehechos.add(p.sourceId); // el paso 3 lo vuelve a postear
    if (aplicar) await f.posting.reverseExpense(p.sourceId, AUTOR);
  }

  // 2. Ventas.
  for (const v of ventas) {
    const vivo = ventasVivas.has(v.id);
    if (v.status === 'void' && vivo) {
      c.ventasAnuladasConAsiento!++;
      if (aplicar) await f.posting.reverseSale(v.id, AUTOR);
    } else if (v.status !== 'void' && !vivo) {
      const input = insumoVenta(v);
      if (!input) continue;
      if (!debePostear('sale', v.id)) {
        c.reversadosSinReposteo!++;
        continue;
      }
      c.ventasSinAsiento!++;
      if (aplicar) await f.posting.postSale(input);
    }
  }

  // 3. Gastos (y asientos de gastos que ya no existen).
  for (const g of gastos) {
    const rehecho = rehechos.has(g.id);
    if (gastosVivos.has(g.id) && !rehecho) continue;
    const input = insumoGasto(g, kinds.get(g.categoryId), descuenta(g.sedeId));
    if (!input) continue;
    if (!rehecho && !debePostear('expense', g.id)) {
      c.reversadosSinReposteo!++;
      continue;
    }
    if (!rehecho) c.gastosSinAsiento!++;
    if (aplicar) await f.posting.postExpense(input);
  }
  for (const id of gastosVivos) {
    if (gastoPorId.has(id)) continue;
    c.asientosDeGastosBorrados!++;
    if (aplicar) await f.posting.reverseExpense(id, AUTOR);
  }

  // 4. Recepciones de compra.
  for (const o of ordenes) {
    for (const r of recepcionesDeOrden(o, descuenta(o.sedeId))) {
      if (r.tipo === 'vacia') continue;
      if (r.tipo === 'sinId') {
        c.recepcionesSinId!++;
        continue;
      }
      const id = r.tipo === 'postear' ? r.input.receiptId : r.receiptId;
      if (recepcionesVivas.has(id)) continue;
      if (r.tipo !== 'postear') {
        c.recepcionesContado!++;
        continue;
      }
      if (!debePostear('purchase_receipt', id)) {
        c.reversadosSinReposteo!++;
        continue;
      }
      c.recepcionesSinAsiento!++;
      if (aplicar) await f.posting.postPurchaseReceipt(r.input);
    }
  }

  // 5. Pendientes: se resuelven los que ya quedaron bien.
  const vivosAhora = aplicar
    ? new Map(
        await Promise.all(
          ORIGENES_CON_HERRAMIENTA.map(
            async (t) => [t, await f.origenesVivos(t)] as const,
          ),
        ),
      )
    : null;
  const ventaPorId = new Map(ventas.map((v) => [v.id, v]));
  for (const p of pendientes) {
    if (!ORIGENES_CON_HERRAMIENTA.includes(p.sourceType)) {
      c.pendientesManuales!++;
      continue;
    }
    if (!vivosAhora) continue;
    const vivo = vivosAhora.get(p.sourceType)!.has(p.sourceId);
    const debeExistir =
      p.sourceType === 'sale'
        ? ventaPorId.get(p.sourceId)?.status === 'completed'
        : p.sourceType === 'expense'
          ? gastoPorId.has(p.sourceId)
          : true;
    // Un `post` se resuelve cuando el asiento está vivo; un `reverse`, cuando
    // el estado del libro coincide con el del documento.
    const bien = p.operacion === 'post' ? vivo : vivo === debeExistir;
    if (bien) await f.resolver(p);
  }
  return c;
}
