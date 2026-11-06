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

import { SaldoFavorService } from './saldo-favor.service';

/**
 * Saldo a favor por cliente (Fase 6C): abono y consumo idempotentes por
 * origen, consumo atómico contra el saldo, reverso al anular y reporte que
 * concilia saldo, auxiliar y mayor de la 2805.
 */
describe('SaldoFavorService', () => {
  const A = new Types.ObjectId();
  let filas: Map<string, { customerId: Types.ObjectId; saldo: number; customerName?: string }>;
  let movs: any[];
  let libro: number;
  let svc: SaldoFavorService;

  beforeEach(() => {
    filas = new Map();
    movs = [];
    libro = 0;
    const saldos: any = {
      findOne: vi.fn((f: any) => ({ exec: async () => filas.get(String(f.customerId)) ?? null })),
      findOneAndUpdate: vi.fn((f: any, u: any, o: any = {}) => ({
        exec: async () => {
          const k = String(f.customerId);
          let fila = filas.get(k);
          if (!fila && o.upsert) filas.set(k, (fila = { customerId: f.customerId, saldo: 0 }));
          if (!fila) return null;
          if (f.saldo?.$gte !== undefined && fila.saldo < f.saldo.$gte) return null;
          fila.saldo += u.$inc.saldo;
          if (u.$set) Object.assign(fila, u.$set);
          return fila;
        },
      })),
      find: vi.fn(() => ({ sort: () => ({ exec: async () => [...filas.values()] }) })),
    };
    const movimientos: any = {
      create: vi.fn(async (d: any) => {
        if (movs.some((m) => m.sourceType === d.sourceType && m.sourceId === d.sourceId && m.tipo === d.tipo)) {
          throw Object.assign(new Error('dup'), { code: 11000 });
        }
        const m = { ...d, _id: new Types.ObjectId() };
        movs.push(m);
        return m;
      }),
      deleteOne: vi.fn((f: any) => ({ exec: async () => void (movs = movs.filter((m) => String(m._id) !== String(f._id))) })),
      findOne: vi.fn((f: any) => ({
        exec: async () => movs.find((m) => m.sourceType === f.sourceType && m.sourceId === f.sourceId && m.tipo === f.tipo) ?? null,
      })),
      aggregate: vi.fn(() => ({
        exec: async () => {
          const m = new Map<string, number>();
          for (const x of movs) {
            const k = x.customerId ? String(x.customerId) : '';
            m.set(k, (m.get(k) ?? 0) + (x.tipo === 'consumo' ? -x.amount : x.amount));
          }
          return [...m].map(([k, neto]) => ({ _id: k ? new Types.ObjectId(k) : null, neto }));
        },
      })),
    };
    const ledger: any = {
      trialBalance: vi.fn(async () => ({ rows: [{ code: '2805', debit: 0, credit: libro }] })),
    };
    svc = new SaldoFavorService(saldos, movimientos, ledger);
  });

  const abono = (amount: number, sourceId = 'r1', customerId: Types.ObjectId | null = A) =>
    svc.abonar({ customerId, amount, sourceType: 'sale_return', sourceId });

  it('abona una vez por origen', async () => {
    await abono(5_000);
    await abono(5_000);
    expect(await svc.saldoDe(A.toString())).toBe(5_000);
    expect(movs).toHaveLength(1);
  });

  it('consume de forma atómica: si no alcanza, 409 y no queda movimiento', async () => {
    await abono(5_000);
    await expect(svc.consumir({ customerId: A.toString(), amount: 6_000, saleId: 's1' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(movs.filter((m) => m.tipo === 'consumo')).toHaveLength(0);
    await svc.consumir({ customerId: A.toString(), amount: 3_000, saleId: 's1' });
    // El reintento de la misma venta no gasta otra vez.
    await svc.consumir({ customerId: A.toString(), amount: 3_000, saleId: 's1' });
    expect(await svc.saldoDe(A.toString())).toBe(2_000);
  });

  it('dos cobros a la vez no gastan el mismo peso', async () => {
    await abono(5_000);
    const r = await Promise.allSettled([
      svc.consumir({ customerId: A.toString(), amount: 4_000, saleId: 's1' }),
      svc.consumir({ customerId: A.toString(), amount: 4_000, saleId: 's2' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await svc.saldoDe(A.toString())).toBe(1_000);
  });

  it('anular la venta devuelve lo gastado, una sola vez', async () => {
    await abono(5_000);
    await svc.consumir({ customerId: A.toString(), amount: 3_000, saleId: 's1' });
    await svc.revertirConsumo('s1');
    await svc.revertirConsumo('s1');
    expect(await svc.saldoDe(A.toString())).toBe(5_000);
    // Una venta sin consumo no hace nada.
    await svc.revertirConsumo('otra');
    expect(movs).toHaveLength(3);
  });

  it('reporte: saldo por tercero, sin tercero y diferencia contra el mayor de la 2805', async () => {
    await abono(5_000);
    await abono(1_000, 'r2', null);
    await svc.consumir({ customerId: A.toString(), amount: 2_000, saleId: 's1' });
    libro = 4_500;
    const r = await svc.reporte();
    expect(r.filas).toEqual([
      { customerId: A.toString(), customerName: undefined, saldo: 3_000, movimientos: 3_000, descuadre: 0 },
    ]);
    expect(r.totalClientes).toBe(3_000);
    expect(r.sinTercero).toBe(1_000);
    expect(r.libro2805).toBe(4_500);
    // $500 en la 2805 sin auxiliar: saldos de antes de la Fase 6C.
    expect(r.diferenciaLibro).toBe(500);
  });
});
