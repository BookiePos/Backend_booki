import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});
vi.mock('@vercel/functions', () => ({ waitUntil: () => undefined }));

import { NotasSinReferenciaService } from './notas-sin-referencia.service';
import { NotaFiscalVentaService } from './nota-fiscal-venta.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** Descuento sin referencia (Fase 6C): nota primero, caja y libro después, idempotente. */
describe('NotasSinReferenciaService', () => {
  const sedeId = new Types.ObjectId().toString();
  const customerId = new Types.ObjectId();
  const user = { userId: 'u1', email: 'sup@b.co', sedeIds: [sedeId], permissions: [] } as unknown as JwtUser;
  let registros: any[];
  let orden: string[];
  let puerto: any;
  let caja: any;
  let ledger: any;
  let svc: NotasSinReferenciaService;
  let cxcs: any[];
  let receivables: any;
  let model: any;

  const dto = (o: Record<string, unknown> = {}) =>
    ({
      sedeId,
      customerId: customerId.toString(),
      concepto: '6',
      desde: '2026-11-01',
      hasta: '2026-11-30',
      amount: 4_000,
      refundMethod: 'cash',
      reason: 'Volumen de noviembre',
      idempotencyKey: 'volumen-nov-001',
      ...o,
    }) as never;

  beforeEach(() => {
    registros = [];
    orden = [];
    cxcs = [];
    receivables = {
      find: vi.fn((f: any) => ({
        sort: () => ({ exec: async () => cxcs.filter((c) => ['open', 'partial'].includes(c.status)) }),
        exec: async () =>
          cxcs.filter((c) => (c.ajustes ?? []).some((a: any) => a.returnId === f['ajustes.returnId'])),
      })),
      findOneAndUpdate: vi.fn((f: any, u: any) => ({
        exec: async () => {
          const c = cxcs.find((x) => String(x._id) === String(f._id));
          if (!c) return null;
          if (u.$pull) {
            c.amount += u.$inc.amount;
            c.ajustes = c.ajustes.filter((a: any) => a.returnId !== u.$pull.ajustes.returnId);
            return c;
          }
          if (f.amount !== c.amount || f.paidAmount !== c.paidAmount) return null;
          c.amount += u.$inc.amount;
          c.ajustes = [...(c.ajustes ?? []), u.$push.ajustes];
          c.status = u.$set.status;
          return c;
        },
      })),
      updateOne: vi.fn(() => ({ exec: async () => ({}) })),
    };
    model = {
      findOne: vi.fn((f: any) => ({ exec: async () => registros.find((r) => r.idempotencyKey === f.idempotencyKey) ?? null })),
      create: vi.fn(async (d: any) => {
        const r = { ...d, _id: new Types.ObjectId(), cajaHecha: false, asientoHecho: false, sedeId: new Types.ObjectId(sedeId), save: vi.fn(async () => undefined) };
        registros.push(r);
        return r;
      }),
      deleteOne: vi.fn((f: any) => ({ exec: async () => void (registros = registros.filter((r) => String(r._id) !== String(f._id))) })),
      updateOne: vi.fn(() => ({ exec: async () => ({}) })),
      findOneAndUpdate: vi.fn((f: any, u: any) => ({
        exec: async () => {
          const r = registros.find((x) => String(x._id) === String(f._id));
          if (!r || r.estado === 'completa' || (r.procesandoHasta && r.procesandoHasta >= new Date())) return null;
          return Object.assign(r, u.$set);
        },
      })),
      findById: vi.fn((id: any) => ({ exec: async () => registros.find((x) => String(x._id) === String(id)) ?? null })),
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            exec: async () =>
              registros.filter((r) => r.estado === 'en_curso' && (!r.procesandoHasta || r.procesandoHasta < new Date())),
          }),
        }),
      })),
    };
    puerto = {
      emitirNota: vi.fn(),
      transmitir: vi.fn(async () => undefined),
      emitirNotaSinReferencia: vi.fn(async (s: any) => {
        orden.push('nota');
        return { estado: 'emitida', documentoId: 'n1', fullNumber: 'NC7', concepto: s.concepto, total: s.monto, iva: 160, inc: 222 };
      }),
    };
    caja = { movement: vi.fn(async () => void orden.push('caja')) };
    ledger = { postSaleReturn: vi.fn(async () => void orden.push('libro')) };
    const customers = { getOrFail: vi.fn(async () => ({ _id: customerId, name: 'Empresa SAS', docNumber: '900555111' })) };
    svc = new NotasSinReferenciaService(
      model,
      customers as never,
      new NotaFiscalVentaService({ get: () => puerto } as never),
      caja,
      ledger,
      receivables,
    );
  });

  it('emite la nota antes de mover caja y libro, con el documento del cliente', async () => {
    const r: any = await svc.create(dto(), user);
    expect(orden).toEqual(['nota', 'caja', 'libro']);
    expect(puerto.emitirNotaSinReferencia.mock.calls[0][0]).toMatchObject({
      origen: `sin_referencia:${String(r._id)}`,
      docNumber: '900555111',
      concepto: '6',
      monto: 4_000,
    });
    expect(ledger.postSaleReturn.mock.calls[0][0]).toMatchObject({
      sourceType: 'nota_sin_referencia',
      refundTotal: 4_000,
      tax: 160,
      consumptionTax: 222,
      cogs: 0,
      refundMethod: 'cash',
    });
    expect(r.estado).toBe('completa');
  });

  it('saldo a favor no toca la caja; el reintento con la misma llave no repite nada', async () => {
    const a: any = await svc.create(dto({ refundMethod: 'credit_note' }), user);
    const b: any = await svc.create(dto({ refundMethod: 'credit_note' }), user);
    expect(b).toBe(a);
    expect(caja.movement).not.toHaveBeenCalled();
    expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
    await expect(svc.create(dto({ amount: 5_000, refundMethod: 'credit_note' }), user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('si la nota falla (tope, sin facturas) no queda nada', async () => {
    puerto.emitirNotaSinReferencia.mockRejectedValueOnce(new ConflictException('tope'));
    await expect(svc.create(dto(), user)).rejects.toThrow('tope');
    expect(registros).toHaveLength(0);
    expect(caja.movement).not.toHaveBeenCalled();
    expect(ledger.postSaleReturn).not.toHaveBeenCalled();
  });

  it('sin caja abierta queda pendiente_caja y el reintento la completa', async () => {
    caja.movement.mockRejectedValueOnce(new Error('sin caja'));
    const r: any = await svc.create(dto(), user);
    expect(r.estado).toBe('pendiente_caja');
    expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
    r.procesandoHasta = null;
    const b: any = await svc.create(dto(), user);
    expect(b.estado).toBe('completa');
    expect(caja.movement).toHaveBeenCalledTimes(2);
    expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
  });

  it('cartera viva: abona primero las CxC del cliente (1305) y solo el excedente sale por el medio', async () => {
    cxcs = [{ _id: new Types.ObjectId(), customerId, amount: 10_000, paidAmount: 7_000, status: 'partial', ajustes: [] }];
    const r: any = await svc.create(dto(), user);
    expect(r.abonoCartera).toBe(3_000);
    expect(cxcs[0]).toMatchObject({ amount: 7_000, status: 'paid' });
    expect(cxcs[0].ajustes[0].returnId).toBe(`sin_referencia:${String(r._id)}`);
    expect(caja.movement.mock.calls[0][0].amount).toBe(1_000);
    expect(ledger.postSaleReturn.mock.calls[0][0]).toMatchObject({ refundTotal: 4_000, toReceivable: 3_000 });
  });

  it('si la nota falla, la cartera vuelve a su valor', async () => {
    cxcs = [{ _id: new Types.ObjectId(), customerId, amount: 10_000, paidAmount: 7_000, status: 'partial', ajustes: [] }];
    puerto.emitirNotaSinReferencia.mockRejectedValueOnce(new ConflictException('tope'));
    await expect(svc.create(dto(), user)).rejects.toThrow('tope');
    expect(cxcs[0].amount).toBe(10_000);
    expect(cxcs[0].ajustes).toHaveLength(0);
  });

  it('guarda el reparto de la nota por venta y producto (tope cruzado)', async () => {
    const saleId = new Types.ObjectId().toString();
    puerto.emitirNotaSinReferencia.mockImplementationOnce(async (s: any) => ({
      estado: 'emitida', documentoId: 'n1', fullNumber: 'NC7', concepto: s.concepto, total: s.monto, iva: 0, inc: 0,
      asignaciones: [{ saleId, productId: 'p1', valor: 4_000, impuesto: 0 }],
    }));
    const r: any = await svc.create(dto(), user);
    expect(r.asignaciones).toEqual([{ saleId: new Types.ObjectId(saleId), productId: 'p1', amount: 4_000, tax: 0 }]);
  });

  it('barrido de varadas: completa libro sin tocar la caja (queda pendiente_caja)', async () => {
    const r: any = await svc.create(dto(), user);
    // Simula que se cortó tras la nota: sin caja ni asiento.
    Object.assign(r, { estado: 'en_curso', cajaHecha: false, asientoHecho: false, procesandoHasta: null });
    caja.movement.mockClear();
    ledger.postSaleReturn.mockClear();
    const res = await svc.completarVaradas();
    expect(res).toEqual({ completadas: 0, pendientesCaja: 1, fallidas: 0 });
    expect(caja.movement).not.toHaveBeenCalled();
    expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
    expect(r.estado).toBe('pendiente_caja');
  });
});
