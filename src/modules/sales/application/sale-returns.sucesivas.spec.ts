import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

// Mismo parche que el resto de las pruebas de ventas: SWC emite `Object` como
// metadata de los @Prop() con uniones y @nestjs/mongoose revienta al importar.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { SaleReturnsService } from './sale-returns.service';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { ACC } from '../../core-ledger/domain/ledger.constants';
import { prorateCop, splitTaxIncluded } from '../domain/sale-amounts';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Devoluciones sucesivas sobre una misma venta (ítem 1.16, punto a).
 *
 * Una venta con descuento de línea, descuento de toda la venta, IVA, INC y
 * propina se devuelve en varios pedazos impares. Al final, lo devuelto más lo
 * que queda tiene que cuadrar peso por peso con la venta original en los tres
 * lugares donde vive la plata: la venta (lo reembolsado por línea), la caja
 * del turno y el libro (cuenta por cuenta, incluido el costo de venta).
 *
 * Los montos se escogieron para que nada divida exacto: con un redondeo por
 * devolución, tres devoluciones de 1 sobre $10.000 dejaban un peso colgado.
 */

const sedeId = new Types.ObjectId();
const saleId = new Types.ObjectId();

const user: JwtUser = {
  userId: 'u1',
  email: 'cajero@bookipos.local',
  name: 'Cajero',
  role: 'cashier',
  sedeIds: [sedeId.toString()],
  permissions: [],
} as unknown as JwtUser;

interface Producto {
  id: Types.ObjectId;
  inv: Types.ObjectId;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  kind: 'iva' | 'inc';
  rate: number;
  cost: number;
}

const HAMBURGUESA: Producto = {
  id: new Types.ObjectId(),
  inv: new Types.ObjectId(),
  qty: 3,
  unitPrice: 10_001,
  lineDiscount: 1_000,
  kind: 'inc',
  rate: 8,
  cost: 10_000,
};
const GASEOSA: Producto = {
  id: new Types.ObjectId(),
  inv: new Types.ObjectId(),
  qty: 7,
  unitPrice: 3_333,
  lineDiscount: 0,
  kind: 'iva',
  rate: 19,
  cost: 7_001,
};
const CERVEZA: Producto = {
  id: new Types.ObjectId(),
  inv: new Types.ObjectId(),
  qty: 6,
  unitPrice: 4_999,
  lineDiscount: 334,
  kind: 'iva',
  rate: 19,
  cost: 9_999,
};
const PRODUCTOS = [HAMBURGUESA, GASEOSA, CERVEZA];
const DESCUENTO_VENTA = 1_237;
const PROPINA = 5_000;

/** La venta, armada con los mismos repartos que usa `SalesService.create`. */
function armarVenta() {
  const netos = PRODUCTOS.map((p) => p.unitPrice * p.qty - p.lineDiscount);
  const cuotas = prorateCop(DESCUENTO_VENTA, netos);
  const lines = PRODUCTOS.map((p, i) => {
    const { base, tax } = splitTaxIncluded(netos[i]! - cuotas[i]!, p.rate);
    return {
      productId: p.id,
      sku: p.id.toString().slice(-4),
      name: `P${i}`,
      qty: p.qty,
      unitPrice: p.unitPrice,
      taxKind: p.kind,
      taxBase: base,
      taxAmount: tax,
    };
  });
  const total = lines.reduce((s, l) => s + l.taxBase + l.taxAmount, 0);
  return {
    _id: saleId,
    saleNumber: 'FV-000777',
    sedeId: { _id: sedeId },
    status: 'completed',
    total,
    tip: PROPINA,
    lines,
    components: PRODUCTOS.map((p) => ({
      productId: p.inv,
      qty: p.qty,
      cost: p.cost,
      consumedLots: [{ lotId: new Types.ObjectId(), qty: p.qty, unitCost: p.cost / p.qty }],
    })),
  };
}

/** Monta el servicio con un modelo que SÍ recuerda las devoluciones anteriores. */
function montar() {
  const venta = armarVenta();
  const registros: any[] = [];
  const asientos: { sourceType: string; lines: any[] }[] = [];
  const caja: { type: 'in' | 'out'; amount: number }[] = [];

  const ledger = {
    findBySource: vi.fn().mockResolvedValue(null),
    post: vi.fn((e: any) => {
      asientos.push(e);
      return Promise.resolve(e);
    }),
  };
  const posting = new LedgerPostingService(
    ledger as never,
    { registrar: vi.fn() } as never,
  );

  const invDe = new Map(PRODUCTOS.map((p) => [p.id.toString(), p.inv.toString()]));
  const model = {
    find: vi.fn(() => ({
      sort: () => ({ exec: () => Promise.resolve([...registros]) }),
      exec: () => Promise.resolve([...registros]),
    })),
    create: vi.fn((doc: any) => {
      const r = { ...doc, _id: new Types.ObjectId(), save: vi.fn() };
      registros.push(r);
      return Promise.resolve(r);
    }),
    deleteOne: vi.fn(),
  };

  const service = new SaleReturnsService(
    model as never,
    { getOrFail: vi.fn().mockResolvedValue(venta) } as never,
    {
      reverseSale: vi.fn().mockResolvedValue(undefined),
      adjust: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      loadSellableOrFail: vi.fn((id: string) => Promise.resolve({ _id: id })),
      componentsOf: vi.fn((p: { _id: string }, qty: number) => [
        { productId: invDe.get(p._id.toString())!, qty },
      ]),
    } as never,
    {
      movement: vi.fn((m: any) => {
        caja.push({ type: m.type, amount: m.amount });
        return Promise.resolve();
      }),
    } as never,
    posting,
  );

  return { venta, registros, asientos, caja, service, posting };
}

/** Saldo de una cuenta en el libro: débitos − créditos. */
function saldo(asientos: { lines: any[] }[], cuenta: string): number {
  return asientos
    .flatMap((a) => a.lines)
    .filter((l) => l.accountCode === cuenta)
    .reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
}

async function postearVenta(m: ReturnType<typeof montar>) {
  const { venta } = m;
  const suma = (kind: 'iva' | 'inc') =>
    venta.lines.filter((l) => l.taxKind === kind).reduce((s, l) => s + l.taxAmount, 0);
  await m.posting.postSale({
    saleId: saleId.toString(),
    number: venta.saleNumber,
    date: '2026-10-16',
    sedeId: sedeId.toString(),
    total: venta.total,
    tax: suma('iva'),
    consumptionTax: suma('inc'),
    cogs: venta.components.reduce((s, c) => s + c.cost, 0),
    tip: PROPINA,
    paymentMethod: 'cash',
  });
  m.caja.push({ type: 'in', amount: venta.total + PROPINA });
}

/** Devuelve `qty` de un producto, todo al estante y en efectivo. */
function devolver(
  m: ReturnType<typeof montar>,
  pares: [Producto, number][],
  extra: Record<string, unknown> = {},
) {
  return m.service.create(
    saleId.toString(),
    {
      lines: pares.map(([p, qty]) => ({ productId: p.id.toString(), qty })),
      reason: 'sobrante',
      restock: 'inventory',
      refundMethod: 'cash',
      ...extra,
    } as never,
    user,
  );
}

describe('devoluciones sucesivas · ni un peso perdido (ítem 1.16 a)', () => {
  it('la venta de prueba no divide exacto en ninguna línea', () => {
    const { venta } = montar();
    for (const l of venta.lines) {
      expect((l.taxBase + l.taxAmount) % l.qty).not.toBe(0);
    }
    for (const c of venta.components) expect(c.cost % c.qty).not.toBe(0);
  });

  it('devolviéndolo TODO en pedazos, venta, caja y libro vuelven exacto al punto de partida', async () => {
    const m = montar();
    await postearVenta(m);

    await devolver(m, [[HAMBURGUESA, 1], [GASEOSA, 2]]);
    await devolver(m, [[CERVEZA, 1]]);
    await devolver(m, [[HAMBURGUESA, 1], [GASEOSA, 3], [CERVEZA, 2]]);
    await devolver(m, [[GASEOSA, 1], [CERVEZA, 2]]);
    await devolver(m, [[HAMBURGUESA, 1], [GASEOSA, 1], [CERVEZA, 1]]);

    // 1. La venta: por cada línea, lo reembolsado es EXACTO lo que se pagó, y
    //    el impuesto reversado es exacto el causado.
    for (const l of m.venta.lines) {
      const ret = m.registros.flatMap((r) => r.lines).filter((x) => x.productId.equals(l.productId));
      expect(ret.reduce((s, x) => s + x.qty, 0)).toBe(l.qty);
      expect(ret.reduce((s, x) => s + x.refund, 0)).toBe(l.taxBase + l.taxAmount);
      expect(ret.reduce((s, x) => s + x.refundTax, 0)).toBe(l.taxAmount);
      for (const x of ret) expect(Number.isInteger(x.refund)).toBe(true);
    }
    const devuelto = m.registros.reduce((s, r) => s + r.refundTotal, 0);
    expect(devuelto).toBe(m.venta.total);

    // 2. La caja: entró total + propina y salió lo devuelto. Queda la propina,
    //    que es del personal y no se devuelve con la mercancía.
    const neto = m.caja.reduce((s, c) => s + (c.type === 'in' ? c.amount : -c.amount), 0);
    expect(neto).toBe(PROPINA);
    expect(devuelto + neto).toBe(m.venta.total + PROPINA);

    // 3. El libro: cada asiento cuadra, y cuenta por cuenta queda solo la
    //    propina (Caja contra 2380). Ingreso neto, IVA, INC, costo e inventario
    //    vuelven a cero.
    for (const a of m.asientos) {
      const d = a.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      const c = a.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
      expect(d).toBe(c);
    }
    expect(saldo(m.asientos, ACC.CAJA)).toBe(PROPINA);
    expect(saldo(m.asientos, ACC.PROPINAS_POR_PAGAR)).toBe(-PROPINA);
    expect(
      saldo(m.asientos, ACC.INGRESOS_VENTAS) + saldo(m.asientos, ACC.DEVOLUCIONES_VENTAS),
    ).toBe(0);
    expect(saldo(m.asientos, ACC.IVA_POR_PAGAR)).toBe(0);
    expect(saldo(m.asientos, ACC.INC_POR_PAGAR)).toBe(0);
    expect(saldo(m.asientos, ACC.COSTO_VENTA)).toBe(0);
    expect(saldo(m.asientos, ACC.INVENTARIO)).toBe(0);
  });

  it('a mitad de camino, lo devuelto más lo que queda es la venta original', async () => {
    const m = montar();
    await postearVenta(m);

    await devolver(m, [[HAMBURGUESA, 1], [CERVEZA, 1]]);
    await devolver(m, [[GASEOSA, 3]], { refundMethod: 'credit_note' });
    await devolver(m, [[CERVEZA, 2]], { restock: 'waste' });

    const devuelto = m.registros.reduce((s, r) => s + r.refundTotal, 0);
    const queda =
      saldo(m.asientos, ACC.INGRESOS_VENTAS) +
      saldo(m.asientos, ACC.DEVOLUCIONES_VENTAS) +
      saldo(m.asientos, ACC.IVA_POR_PAGAR) +
      saldo(m.asientos, ACC.INC_POR_PAGAR);
    // Lo que el libro todavía reconoce (ingreso + impuestos, en negativo por
    // ser créditos) más lo devuelto es el total de la venta, peso por peso.
    expect(devuelto - queda).toBe(m.venta.total);

    // La caja solo devolvió el efectivo: la nota a favor quedó en Clientes.
    const efectivo = m.registros
      .filter((r) => r.refundMethod === 'cash')
      .reduce((s, r) => s + r.refundTotal, 0);
    expect(saldo(m.asientos, ACC.CAJA)).toBe(m.venta.total + PROPINA - efectivo);
    const nota = m.registros.find((r) => r.refundMethod === 'credit_note')!;
    expect(saldo(m.asientos, ACC.CLIENTES)).toBe(-nota.refundTotal);
  });

  it('el costo devuelto en pedazos suma exacto el costo de la venta', async () => {
    // 1 + 1 + 1 de una línea de 3 que costó $10.000: redondeando cada
    // devolución por su cuenta salían 333 × 3 = 999, y quedaba $1 de costo de
    // venta por mercancía que ya volvió entera al estante.
    const m = montar();
    await postearVenta(m);
    await devolver(m, [[HAMBURGUESA, 1]]);
    await devolver(m, [[HAMBURGUESA, 1]]);
    await devolver(m, [[HAMBURGUESA, 1]]);

    const costoDevuelto = m.asientos
      .filter((a) => a.sourceType === 'sale_return')
      .flatMap((a) => a.lines)
      .filter((l) => l.accountCode === ACC.COSTO_VENTA)
      .reduce((s, l) => s + (l.credit ?? 0), 0);
    expect(costoDevuelto).toBe(HAMBURGUESA.cost);
  });

  it('lo que se fue a merma no deshace su costo, pero no corre el reparto de las siguientes', async () => {
    // Si la primera devolución (merma) no contara como devuelta, la segunda y
    // la tercera se repartirían el costo de las tres unidades.
    const m = montar();
    await postearVenta(m);
    await devolver(m, [[HAMBURGUESA, 1]], { restock: 'waste' });
    await devolver(m, [[HAMBURGUESA, 1]]);
    await devolver(m, [[HAMBURGUESA, 1]]);

    const costos = m.asientos
      .filter((a) => a.sourceType === 'sale_return')
      .map((a) =>
        a.lines
          .filter((l) => l.accountCode === ACC.COSTO_VENTA)
          .reduce((s, l) => s + (l.credit ?? 0), 0),
      );
    // La merma no lleva costo; las otras dos son las 2/3 restantes del costo.
    expect(costos.reduce((s, c) => s + c, 0)).toBe(10_000 - 3_333);
  });
});
