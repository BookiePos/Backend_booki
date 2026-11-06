import { sumBy } from '../../finance/domain/money.util';
import { primerTributo, type CargoDocumento, type LineaDocumento, type TotalesDocumento } from './documento-venta';

/**
 * Líneas, tope y totales de la nota crédito (FEV, 91) o de la nota de ajuste
 * crédito (POS, 94) que nace de una devolución o de una anulación de la venta
 * (Fase 6B; estudio `documentacion/fe-fase6-notas.md` §2 y §4).
 *
 * El documento fiscal SIGUE a la operación: los valores de la nota son los
 * mismos que la devolución lleva al libro (`refund`/`refundTax` del plan de
 * `sales/domain/sale-return.ts`), así la DIAN y el libro dicen lo mismo. Aquí
 * solo se decide si caben en lo que el documento referido facturó.
 *
 * Tope (§2.2): por cada grupo (producto de la venta, o el domicilio) se lleva
 * la cantidad, la base, el IVA (01) y el INC (04) POR SEPARADO; lo acreditado
 * por las notas previas no rechazadas más esta nunca pasa de lo facturado.
 * La propina (cargo de documento) vuelve entera en la anulación y, en la
 * devolución parcial, en proporción a lo devuelto (decisión 4 del dueño,
 * 2026-11-06): la calcula la devolución y aquí solo se topa contra la
 * facturada menos la ya acreditada.
 *
 * Dominio puro: sin Nest ni Mongoose. Todo en COP entero.
 */

/** La nota pedida no cabe en lo que queda por acreditar. Quien llama lo vuelve 409. */
export class TopeNotaExcedidoError extends Error {}

/** Los datos no permiten relacionar la nota con el documento referido. Quien llama lo vuelve 409. */
export class NotaNoRelacionableError extends Error {}

/** Grupo del domicilio (línea propia del documento, sin producto). */
export const GRUPO_DOMICILIO = 'domicilio';

/** Concepto de la nota que emite BookiPos: 1 devolución parcial, 2 anulación (decisión 3: sin 3-6). */
export type ConceptoNotaVenta = '1' | '2';

/** Línea del documento referido con su grupo (producto de la venta o domicilio). */
export type LineaReferida = LineaDocumento & { refKey: string };

/** Línea de una nota previa: sin `refKey` es una nota vieja por el total. */
export type LineaPrevia = Pick<LineaDocumento, 'qty' | 'base' | 'taxScheme' | 'taxAmount'> & {
  refKey?: string;
};

/** Lo que queda por acreditar de un grupo. */
export interface SaldoGrupo {
  qty: number;
  base: number;
  iva: number;
  inc: number;
}

/** Una línea que la devolución pide acreditar: los valores del plan de la devolución. */
export interface LineaPedida {
  refKey: string;
  qty: number;
  /** Lo devuelto por la línea, con impuesto (`refund`). */
  valor: number;
  /** Impuesto incluido en `valor` (`refundTax`). */
  impuesto: number;
}

const vacio = (): SaldoGrupo => ({ qty: 0, base: 0, iva: 0, inc: 0 });

function sumar(m: Map<string, SaldoGrupo>, key: string, l: LineaPrevia, signo: 1 | -1) {
  const s = m.get(key) ?? vacio();
  const impuesto = l.taxScheme ? (l.taxAmount ?? 0) : 0;
  s.qty += signo * l.qty;
  s.base += signo * l.base;
  if (l.taxScheme === '01') s.iva += signo * impuesto;
  if (l.taxScheme === '04') s.inc += signo * impuesto;
  m.set(key, s);
}

/**
 * Cuánto queda por acreditar de cada grupo: lo facturado menos lo de las notas
 * previas (que el llamador ya filtró: crédito, del mismo documento, no
 * rechazadas). Una nota previa sin `refKey` es de antes de la Fase 6B y se
 * emitió por el total: con ella ya no cabe ninguna nota.
 */
export function saldoAcreditable(
  referidas: readonly LineaReferida[],
  previas: readonly (readonly LineaPrevia[])[],
): Map<string, SaldoGrupo> {
  const saldo = new Map<string, SaldoGrupo>();
  for (const l of referidas) sumar(saldo, l.refKey, l, 1);
  for (const nota of previas) {
    if (nota.length === 0 || nota.some((l) => !l.refKey)) {
      throw new TopeNotaExcedidoError(
        'El documento ya tiene una nota crédito por el total: no admite otra nota.',
      );
    }
    for (const l of nota) sumar(saldo, l.refKey!, l, -1);
  }
  return saldo;
}

/**
 * Líneas de la nota de una devolución (concepto 1): una por producto devuelto,
 * con la cantidad y los valores del plan de la devolución, el tributo y la
 * tarifa del documento referido. Lanza `TopeNotaExcedidoError` si alguna línea
 * pasa de su saldo en cantidad, base, IVA o INC.
 */
export function lineasDeDevolucion(
  referidas: readonly LineaReferida[],
  previas: readonly (readonly LineaPrevia[])[],
  pedidas: readonly LineaPedida[],
): LineaReferida[] {
  if (pedidas.length === 0) throw new NotaNoRelacionableError('La nota no tiene líneas');
  const saldo = saldoAcreditable(referidas, previas);
  const usado = new Map<string, SaldoGrupo>();
  return pedidas.map((p) => {
    const ref = referidas.find((l) => l.refKey === p.refKey);
    if (!ref) {
      throw new NotaNoRelacionableError('Un producto devuelto no está en el documento fiscal de la venta');
    }
    if (!(p.qty > 0) || p.valor < 0 || p.impuesto < 0 || p.impuesto > p.valor) {
      throw new NotaNoRelacionableError('La línea de la nota tiene valores inválidos');
    }
    const taxScheme = ref.taxScheme;
    // Una línea sin tributo en el documento (excluida, o venta sin desglose) no
    // puede acreditar impuesto: va todo como base, igual que se facturó.
    const taxAmount = taxScheme ? p.impuesto : 0;
    const base = p.valor - taxAmount;
    const linea: LineaReferida = {
      refKey: p.refKey,
      code: ref.code,
      description: ref.description,
      qty: p.qty,
      unitCode: ref.unitCode,
      unitPrice: ref.unitPrice,
      discountAmount: 0,
      base,
      taxScheme,
      taxRate: ref.taxRate,
      taxAmount,
      ivaRate: taxScheme === '01' ? ref.taxRate : 0,
      ivaAmount: taxScheme === '01' ? taxAmount : 0,
      total: base + taxAmount,
    };
    // Dos pedidas del mismo grupo suman contra el mismo saldo.
    sumar(usado, p.refKey, linea, 1);
    const u = usado.get(p.refKey)!;
    const s = saldo.get(p.refKey) ?? vacio();
    const excede: string[] = [];
    if (u.qty > s.qty) excede.push(`cantidad ${u.qty} de ${Math.max(s.qty, 0)}`);
    if (u.base > s.base) excede.push(`base $${u.base} de $${Math.max(s.base, 0)}`);
    if (u.iva > s.iva) excede.push(`IVA $${u.iva} de $${Math.max(s.iva, 0)}`);
    if (u.inc > s.inc) excede.push(`INC $${u.inc} de $${Math.max(s.inc, 0)}`);
    if (excede.length > 0) {
      throw new TopeNotaExcedidoError(
        `«${ref.description}» excede lo que queda por acreditar en el documento fiscal (${excede.join(', ')}).`,
      );
    }
    return linea;
  });
}

/** Cargo con su signo: + cargo, − descuento de documento. */
const conSigno = (c: Pick<CargoDocumento, 'chargeIndicator' | 'amount'>) =>
  c.chargeIndicator ? c.amount : -c.amount;

/**
 * Cargo de propina de la nota de una devolución (concepto 1, decisión 4): la
 * propina que devolvió la operación, como cargo de documento con el motivo
 * del documento referido. Lanza `TopeNotaExcedidoError` si pasa de la
 * facturada menos la que acreditaron las notas previas.
 */
export function cargosDeDevolucion(
  cargosReferido: readonly CargoDocumento[],
  cargosPrevios: readonly (readonly CargoDocumento[])[],
  propina: number,
): CargoDocumento[] {
  if (!(propina > 0)) return [];
  const facturada = sumBy(cargosReferido, conSigno);
  const acreditada = sumBy(cargosPrevios.flat(), conSigno);
  const saldo = facturada - acreditada;
  if (propina > saldo) {
    throw new TopeNotaExcedidoError(
      `La propina devuelta ($${propina}) excede la que queda por acreditar en el documento fiscal ($${Math.max(saldo, 0)}).`,
    );
  }
  const reason = cargosReferido.find((c) => c.chargeIndicator)?.reason ?? 'Propina voluntaria';
  return [{ chargeIndicator: true, reason, amount: propina }];
}

/**
 * Líneas y cargos de la nota de una anulación (concepto 2): el documento
 * entero, propina incluida. Una anulación no cabe si ya hay notas (§2.2: la
 * nota parcial no usa el 2 y las notas no se ajustan entre sí).
 */
export function lineasDeAnulacion(
  referidas: readonly LineaReferida[],
  cargos: readonly CargoDocumento[],
  previas: readonly (readonly LineaPrevia[])[],
): { lineas: LineaReferida[]; cargos: CargoDocumento[] } {
  if (previas.length > 0) {
    throw new TopeNotaExcedidoError(
      'El documento fiscal ya tiene notas crédito: no se puede anular entero. Registra una devolución por lo que queda.',
    );
  }
  if (referidas.length === 0) throw new NotaNoRelacionableError('El documento referido no tiene líneas');
  return {
    lineas: referidas.map((l) => ({ ...l })),
    cargos: cargos.map((c) => ({ chargeIndicator: c.chargeIndicator, reason: c.reason, amount: c.amount })),
  };
}

/** Totales de la nota: la suma de sus líneas y cargos (mismo criterio que `documentoDeVenta`). */
export function totalesDeNota(
  lineas: readonly LineaDocumento[],
  cargos: readonly CargoDocumento[],
): TotalesDocumento {
  const de = (codigo: '01' | '04') => sumBy(lineas, (l) => (l.taxScheme === codigo ? l.taxAmount : 0));
  const taxableBase = sumBy(lineas, (l) => l.base);
  const taxExclusiveAmount = sumBy(lineas, (l) => primerTributo(l)?.taxableAmount ?? 0);
  const ivaTotal = de('01');
  const incTotal = de('04');
  const bagTaxTotal = sumBy(lineas, (l) => l.perUnitTax?.valor ?? 0);
  const taxInclusiveAmount = taxableBase + ivaTotal + incTotal + bagTaxTotal;
  const chargeTotal = sumBy(cargos, (c) => (c.chargeIndicator ? c.amount : -c.amount));
  return {
    taxableBase,
    taxExclusiveAmount,
    ivaTotal,
    incTotal,
    icaTotal: 0,
    bagTaxTotal,
    taxInclusiveAmount,
    chargeTotal,
    payableAmount: taxInclusiveAmount + chargeTotal,
  };
}

/**
 * Grupo de cada línea del documento referido. El documento se armó con
 * `documentoDeVenta`: una línea por línea de la venta, en el mismo orden, y el
 * domicilio al final. Si no cuadra, no se adivina.
 */
export function gruposDelDocumento(
  lineasDoc: readonly LineaDocumento[],
  productosVenta: readonly string[],
  tieneDomicilio: boolean,
): LineaReferida[] {
  const esperadas = productosVenta.length + (tieneDomicilio ? 1 : 0);
  if (lineasDoc.length !== esperadas) {
    throw new NotaNoRelacionableError(
      'Las líneas del documento fiscal no corresponden a las de la venta: la nota no se puede armar. Revísalo con soporte.',
    );
  }
  return lineasDoc.map((l, i) => ({
    ...l,
    refKey: i < productosVenta.length ? productosVenta[i]! : GRUPO_DOMICILIO,
  }));
}
