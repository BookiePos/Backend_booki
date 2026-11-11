import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

// Patrón de `orders.service.checkout.spec.ts`: neutraliza los decoradores.
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

import { EinvoicingService, MENSAJE_NOTA_EN_CURSO } from './einvoicing.service';
import { documentoDeVenta } from '../domain/documento-venta';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Candado de notas por documento (deuda de la Fase 6C): una nota con
 * referencia y otra sin referencia emitidas A LA VEZ sobre la misma factura
 * leían el mismo saldo acreditable y entre las dos reconocían de más.
 *
 * El modelo es un doble en memoria que guarda las notas creadas y respeta lo
 * que Mongo garantiza: el `findOneAndUpdate` del candado evalúa su filtro y
 * escribe en un solo paso. Las lecturas y el guardado ceden el turno, así que
 * dos emisiones a la vez se entrelazan de verdad.
 */
describe('EinvoicingService · candado de notas por documento (deuda de la 6C)', () => {
  const sedeId = new Types.ObjectId().toString();
  const saleId = new Types.ObjectId();
  const HAMB = new Types.ObjectId();
  const GAS = new Types.ObjectId();
  const user = { email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [sedeId] } as unknown as JwtUser;

  // Factura de $40.000: $30.000 con INC y $10.000 con IVA.
  const ventaDoc = {
    lines: [
      { sku: 'H1', name: 'Hamburguesa', qty: 3, unitPrice: 10_000, lineTotal: 30_000, taxKind: 'inc' as const, taxRate: 8, taxBase: 27_778, taxAmount: 2_222 },
      { sku: 'G1', name: 'Gaseosa', qty: 2, unitPrice: 5_000, lineTotal: 10_000, taxKind: 'iva' as const, taxRate: 19, taxTreatment: 'gravado' as const, taxBase: 8_403, taxAmount: 1_597 },
    ],
    total: 40_000,
  };
  const venta = {
    _id: saleId,
    sedeId,
    status: 'completed',
    saleNumber: 'FV-000010',
    payment: { method: 'cash' },
    ...ventaDoc,
    lines: ventaDoc.lines.map((l, i) => ({ ...l, productId: i === 0 ? HAMB : GAS })),
  };
  const armado = documentoDeVenta(ventaDoc);

  let factura: any;
  let notas: any[];
  let model: any;
  let svc: EinvoicingService;
  /** `false` deja el candado sin efecto: el testigo de que la carrera existe. */
  let candadoReal: boolean;

  const turno = () => new Promise<void>((r) => setImmediate(r));
  const cadena = (fn: () => unknown): any => {
    const c: any = {
      sort: () => c,
      select: () => c,
      lean: () => c,
      exec: async () => {
        await turno();
        return fn();
      },
    };
    return c;
  };

  beforeEach(() => {
    candadoReal = true;
    notas = [];
    factura = {
      _id: new Types.ObjectId(),
      type: 'invoice',
      saleId,
      ventaFiscal: saleId,
      sedeId: new Types.ObjectId(sedeId),
      fullNumber: 'FE15',
      issueDate: '2026-11-01',
      cufe: 'c'.repeat(96),
      emisor: { name: 'Negocio', nit: '900123456', nitNorm: '900123456', nitDv: '8', tipoPersona: 'juridica', address: 'Cra 1', departamento: '11', ciudad: 'Bogotá' },
      adquiriente: { docType: '31', docNumber: '900555111', name: 'Cliente Empresa' },
      lines: armado.lines,
      charges: armado.charges,
      ...armado.totales,
      formaPago: '1',
      medioPago: '10',
      dianStatus: 'accepted',
    };
    let seq = 0;
    const deLaFactura = (n: any, id: unknown) =>
      String(n.referenceId) === String(id) || (n.asignaciones ?? []).some((a: any) => String(a.referenceId) === String(id));
    model = {
      findOne: vi.fn((f: any) => {
        if (f.origenNota) return cadena(() => notas.find((n) => n.origenNota === f.origenNota) ?? null);
        return cadena(() => factura);
      }),
      findById: vi.fn(() => cadena(() => factura)),
      find: vi.fn((f: any) =>
        cadena(() => (f.type === 'invoice' ? [factura] : notas.filter((n) => deLaFactura(n, f.$or[0].referenceId)))),
      ),
      // El candado: filtro y escritura en un solo paso, como en Mongo.
      findOneAndUpdate: vi.fn((f: any, u: any) => ({
        exec: async () => {
          await turno();
          const libre = !factura.candadoNotas || factura.candadoNotas.hasta < f.$or[1]['candadoNotas.hasta'].$lt;
          if (candadoReal && !libre) return null;
          factura.candadoNotas = u.$set.candadoNotas;
          return factura;
        },
      })),
      updateOne: vi.fn((f: any, u: any) => ({
        exec: async () => {
          if (u.$unset?.candadoNotas && factura.candadoNotas?.token === f['candadoNotas.token']) {
            delete factura.candadoNotas;
            return { modifiedCount: 1 };
          }
          return { modifiedCount: 0 };
        },
      })),
      create: vi.fn(async (d: any) => {
        await turno();
        const n = { ...d, _id: new Types.ObjectId() };
        notas.push(n);
        return n;
      }),
    };
    const counters = {
      findOneAndUpdate: vi.fn((_f: any, upd: any) => ({
        exec: async () => {
          seq += upd.$inc?.seq ?? 0;
          return { seq };
        },
      })),
    };
    const businesses = {
      consumeDocument: vi.fn(async () => 'monthly'),
      refundDocument: vi.fn(async () => undefined),
      findById: vi.fn(async () => ({})),
    };
    const sedes = { findOrFail: vi.fn(async () => ({ id: sedeId, nit: '900123456', resolucionesFe: [] })) };
    const sales = { getOrFail: vi.fn(async () => venta) };
    const emisores = {
      obtenerPorSede: vi.fn(async () => ({ id: 'e1', tipoAmbiente: '2' })),
      leerSecreto: vi.fn(async () => '12345'),
    };
    svc = new EinvoicingService(model, counters as any, sales as any, sedes as any, businesses as any, emisores as any);
  });

  afterEach(() => vi.useRealTimers());

  const enTenant = <T>(fn: () => Promise<T>) => TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, fn);
  /** Rebaja CON referencia sobre la hamburguesa. */
  const rebaja = (valor: number, impuesto: number, origen = 'rebaja:r1') =>
    enTenant(() =>
      svc.emitirNotaDeVenta(
        { saleId: saleId.toString(), origen, concepto: '3', motivo: 'Rebaja', lineas: [{ productId: HAMB.toString(), qty: 0, valor, impuesto }] } as never,
        user,
      ),
    );
  /** Nota SIN referencia del periodo de la factura. */
  const sinReferencia = (monto: number, origen = 'sin_referencia:x1') =>
    enTenant(() =>
      svc.emitirNotaSinReferencia(
        { origen, sedeId, docNumber: '900555111', concepto: '6', motivo: 'Descuento por volumen', desde: '2026-11-01', hasta: '2026-11-30', monto } as never,
        user,
      ),
    );
  const reconocido = () => notas.reduce((a, n) => a + n.payableAmount, 0);

  it('testigo: sin el candado, las dos notas a la vez reconocen más que la factura', async () => {
    candadoReal = false;
    const r = await Promise.allSettled([rebaja(24_000, 1_778), sinReferencia(30_000)]);
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(reconocido()).toBe(54_000);
  });

  it('con referencia y sin referencia a la vez: entra una y la otra recibe 409 por tope', async () => {
    const r = await Promise.allSettled([rebaja(24_000, 1_778), sinReferencia(30_000)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const fallo = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(fallo.reason).toBeInstanceOf(ConflictException);
    expect(fallo.reason.message).not.toBe(MENSAJE_NOTA_EN_CURSO);
    expect(notas).toHaveLength(1);
    expect(reconocido()).toBeLessThanOrEqual(40_000);
    expect(factura.candadoNotas).toBeUndefined();
  });

  it('a la vez y cabiendo las dos: entran las dos, una detrás de otra, y suman exacto', async () => {
    const r = await Promise.allSettled([rebaja(10_000, 741), sinReferencia(20_000)]);
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(reconocido()).toBe(30_000);
    expect(factura.candadoNotas).toBeUndefined();
  });

  it('muchas a la vez, con y sin referencia: nunca se reconoce más que la factura', async () => {
    const r = await Promise.allSettled([
      ...Array.from({ length: 4 }, (_, i) => rebaja(9_000, 667, `rebaja:r${i}`)),
      ...Array.from({ length: 4 }, (_, i) => sinReferencia(9_000, `sin_referencia:x${i}`)),
    ]);
    expect(reconocido()).toBeLessThanOrEqual(40_000);
    expect(reconocido()).toBe(9_000 * r.filter((x) => x.status === 'fulfilled').length);
    expect(r.filter((x) => x.status === 'fulfilled').length).toBeGreaterThanOrEqual(3);
    expect(factura.candadoNotas).toBeUndefined();
  });

  it('dos notas sin referencia a la vez del mismo cliente tampoco se pisan', async () => {
    const r = await Promise.allSettled([sinReferencia(30_000, 'sin_referencia:a'), sinReferencia(30_000, 'sin_referencia:b')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(reconocido()).toBe(30_000);
  });

  it('candado ocupado y vigente: espera y, si no se libera, 409 sin emitir ni tocar el candado ajeno', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const ajeno = { token: 'otro', hasta: new Date(Date.now() + 10 * 60_000) };
    factura.candadoNotas = ajeno;
    const p = rebaja(10_000, 741).catch((e) => e);
    for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(200);
    const err = await p;
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(MENSAJE_NOTA_EN_CURSO);
    expect(notas).toHaveLength(0);
    expect(factura.candadoNotas).toBe(ajeno);
  });

  it('candado vencido (el proceso murió con él): se retoma y la nota se emite', async () => {
    factura.candadoNotas = { token: 'muerto', hasta: new Date(Date.now() - 1_000) };
    const r: any = await rebaja(10_000, 741);
    expect(r.estado).toBe('emitida');
    expect(factura.candadoNotas).toBeUndefined();
  });

  it('si la emisión falla, el candado se suelta', async () => {
    await expect(rebaja(31_000, 2_296)).rejects.toBeInstanceOf(ConflictException);
    expect(factura.candadoNotas).toBeUndefined();
    await expect(rebaja(10_000, 741)).resolves.toMatchObject({ estado: 'emitida' });
  });
});
