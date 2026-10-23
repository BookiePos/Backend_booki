import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

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

import { PaymentReconciliationService } from './payment-reconciliation.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 6.4: la conciliación recalcula lo cobrado en el servidor, asienta
 * comisión/retenciones, avisa de las diferencias y es idempotente.
 */
describe('PaymentReconciliationService', () => {
  const sedeId = new Types.ObjectId().toString();
  const otraSede = new Types.ObjectId().toString();
  const user = {
    userId: 'u1',
    email: 'g@x.co',
    role: 'manager',
    sedeIds: [sedeId],
    permissions: [],
  } as unknown as JwtUser;

  // Dos ventas con Visa el 20-oct (33.000 + 20.000) y una con Nequi.
  const ventas = [
    {
      total: 30_000,
      tip: 3_000,
      payment: { method: 'card', channel: 'datafono', franchise: 'visa' },
      createdAt: new Date('2026-10-20T15:00:00Z'),
    },
    {
      total: 20_000,
      payment: { method: 'card', channel: 'datafono', franchise: 'visa' },
      createdAt: new Date('2026-10-20T20:00:00Z'),
    },
    {
      total: 10_000,
      payment: { method: 'transfer', channel: 'nequi' },
      createdAt: new Date('2026-10-20T21:00:00Z'),
    },
  ];

  let guardadas: any[];
  let ledger: any;
  let treasury: any;
  let service: PaymentReconciliationService;

  beforeEach(() => {
    guardadas = [];
    ledger = {
      postPaymentSettlement: vi.fn().mockResolvedValue(undefined),
      reversePaymentSettlement: vi.fn().mockResolvedValue(undefined),
    };
    treasury = {
      post: vi.fn().mockResolvedValue(undefined),
      reverse: vi.fn().mockResolvedValue(undefined),
    };
    const salesModel = {
      find: vi.fn(() => ({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve(ventas) }) }),
      })),
    };
    const settlements = {
      find: vi.fn(() => {
        const r: any = Promise.resolve(guardadas);
        const chain: any = { exec: () => r, select: () => chain, lean: () => chain };
        return chain;
      }),
      create: vi.fn((d: any) => {
        if (guardadas.some((g) => g.date === d.date && g.key === d.key)) {
          return Promise.reject({ code: 11000 });
        }
        const doc = { ...d, _id: new Types.ObjectId() };
        guardadas.push(doc);
        return Promise.resolve(doc);
      }),
      findById: vi.fn((id: string) => ({
        exec: () => Promise.resolve(guardadas.find((g) => g._id.toString() === id) ?? null),
      })),
      deleteOne: vi.fn(({ _id }: any) => ({
        exec: () => {
          guardadas = guardadas.filter((g) => g._id !== _id);
          return Promise.resolve({});
        },
      })),
    };
    // Sede responsable de IVA: descuenta el IVA de la comisión.
    const sedes = {
      find: vi.fn(() => ({ select: () => ({ exec: () => Promise.resolve([]) }) })),
    };
    service = new PaymentReconciliationService(
      salesModel as never,
      settlements as never,
      sedes as never,
      ledger as never,
      treasury as never,
      { getById: vi.fn(), findById: vi.fn() } as never,
    );
  });

  it('lista lo cobrado por día y canal, con lo pendiente por conciliar', async () => {
    const r = await service.list(user, { sedeId, from: '2026-10-20', to: '2026-10-20' });
    expect(r.rows.map((x) => [x.key, x.expected, x.tickets])).toEqual([
      ['datafono:visa', 53_000, 2],
      ['nequi', 10_000, 1],
    ]);
    expect(r.totals.expected).toBe(63_000);
    expect(r.totals.pending).toBe(2);
  });

  it('concilia datáfono con comisión y retenciones: asienta y saca de tesorería lo no consignado', async () => {
    const r = await service.create(user, {
      sedeId,
      source: 'manual',
      items: [
        {
          date: '2026-10-20',
          channel: 'datafono',
          franchise: 'visa',
          statementAmount: 50_000,
          commission: 2_000,
          retefuente: 700,
          reteIca: 300,
        },
      ],
    });
    expect(r.created).toHaveLength(1);
    expect(r.created[0]!.difference).toBe(0);
    expect(r.created[0]!.status).toBe('reconciled');
    expect(ledger.postPaymentSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ commission: 2_000, retefuente: 700, reteIca: 300, sedeId }),
    );
    expect(treasury.post).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: 'payment_settlement',
        direction: 'out',
        amount: 3_000,
        channel: 'datafono',
        method: 'card',
      }),
    );
  });

  it('lo que no se explica queda como diferencia, y el monto cobrado lo pone el servidor', async () => {
    const r = await service.create(user, {
      sedeId,
      source: 'csv',
      items: [{ date: '2026-10-20', channel: 'nequi', statementAmount: 9_000 }],
    });
    expect(r.created[0]!.difference).toBe(1_000);
    expect(r.created[0]!.status).toBe('difference');
  });

  it('es idempotente: conciliar dos veces el mismo día y canal no duplica el asiento', async () => {
    const dto = {
      sedeId,
      source: 'manual' as const,
      items: [{ date: '2026-10-20', channel: 'nequi' as const, statementAmount: 10_000 }],
    };
    await service.create(user, dto);
    const again = await service.create(user, dto);
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0]!.reason).toMatch(/Ya estaba/);
    expect(ledger.postPaymentSettlement).toHaveBeenCalledTimes(1);
  });

  it('rechaza conciliar un canal sin cobros ese día', async () => {
    const r = await service.create(user, {
      sedeId,
      source: 'manual',
      items: [{ date: '2026-10-20', channel: 'daviplata', statementAmount: 1_000 }],
    });
    expect(r.created).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/No hubo cobros/);
  });

  it('no deja operar sobre una sede ajena', async () => {
    await expect(
      service.list(user, { sedeId: otraSede, from: '2026-10-20', to: '2026-10-20' }),
    ).rejects.toThrow();
    await expect(
      service.create(user, {
        sedeId: otraSede,
        source: 'manual',
        items: [{ date: '2026-10-20', channel: 'nequi', statementAmount: 1 }],
      }),
    ).rejects.toThrow();
  });

  it('el rango se limita a 93 días', async () => {
    await expect(
      service.list(user, { sedeId, from: '2026-01-01', to: '2026-12-31' }),
    ).rejects.toThrow(/93/);
  });

  it('deshacer reversa el asiento, la tesorería y borra la conciliación', async () => {
    const { created } = await service.create(user, {
      sedeId,
      source: 'manual',
      items: [{ date: '2026-10-20', channel: 'nequi', statementAmount: 9_500, commission: 500 }],
    });
    const out = await service.remove(user, created[0]!.id);
    expect(out.deleted).toBe(true);
    expect(ledger.reversePaymentSettlement).toHaveBeenCalledWith(created[0]!.id, 'g@x.co');
    expect(treasury.reverse).toHaveBeenCalledWith('payment_settlement', created[0]!.id);
    expect(guardadas).toHaveLength(0);
  });

  it('el CSV se cruza con lo cobrado antes de guardar', async () => {
    const r = await service.previewImport(user, {
      sedeId,
      csv: 'fecha,franquicia,neto\n2026-10-20,visa,50000\n',
    });
    expect(r.rows[0]).toMatchObject({ key: 'datafono:visa', expected: 53_000, difference: 3_000 });
    expect(r.rows[0]!.alreadyReconciled).toBe(false);
  });
});
