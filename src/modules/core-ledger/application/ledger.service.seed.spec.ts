import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo patrón que el resto de las pruebas: neutralizar los decoradores de
// @nestjs/mongoose para poder importar los esquemas.
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

import { LedgerService } from './ledger.service';
import { ACC, SEED_ACCOUNTS } from '../domain/ledger.constants';

/**
 * Siembra del plan de cuentas en empresas YA creadas.
 *
 * Antes solo se sembraba si no había ninguna cuenta `system`. Una empresa que
 * nació con el plan viejo (sin 2408/2495) nunca recibía las cuentas nuevas, y
 * `post` lanzaba «Cuentas inexistentes»… que `safePost` se traga: la venta se
 * cobraba y el asiento no existía, sin que nadie se enterara.
 */
describe('LedgerService · siembra del plan en empresas existentes', () => {
  /** Plan con el que nacieron las empresas antes del cambio de PUC. */
  const PLAN_VIEJO = SEED_ACCOUNTS.filter(
    (a) => a.code !== '2408' && a.code !== '2495',
  ).map((a) => ({
    code: a.code,
    // Nombre viejo: la siembra no debe pisarlo.
    name: a.code === '2367' ? 'IVA por pagar' : a.name,
    type: a.type,
    system: true,
  }));

  let db: { code: string; name: string; type: string; system: boolean }[];
  let accounts: any;
  let entries: any;
  let service: LedgerService;

  beforeEach(() => {
    db = PLAN_VIEJO.map((a) => ({ ...a }));
    const query = (filter: any) => {
      const codes: string[] | undefined = filter?.code?.$in;
      return codes ? db.filter((a) => codes.includes(a.code)) : db;
    };
    accounts = {
      countDocuments: vi.fn(() => ({
        exec: () => Promise.resolve(db.filter((a) => a.system).length),
      })),
      find: vi.fn((filter: any) => ({
        select: () => ({ exec: () => Promise.resolve(query(filter)) }),
        sort: () => ({ exec: () => Promise.resolve(query(filter)) }),
        exec: () => Promise.resolve(query(filter)),
      })),
      insertMany: vi.fn(),
      // Upsert por código: solo inserta lo que no existe ($setOnInsert).
      bulkWrite: vi.fn((ops: any[]) => {
        for (const op of ops) {
          const { filter, update, upsert } = op.updateOne;
          const exists = db.some((a) => a.code === filter.code);
          if (!exists && upsert) db.push({ ...update.$setOnInsert });
        }
        return Promise.resolve({});
      }),
    };
    entries = {
      estimatedDocumentCount: vi.fn(() => ({ exec: () => Promise.resolve(0) })),
      create: vi.fn((doc: unknown) => Promise.resolve(doc)),
    };
    service = new LedgerService(accounts as never, entries as never, { findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({ seq: 1 }) })) } as never);
  });

  it('una venta con INC asienta en una empresa creada con el plan viejo', async () => {
    const saved: any = await service.post({
      date: '2026-10-13',
      sourceType: 'sale',
      lines: [
        { accountCode: ACC.CAJA, debit: 30_000 },
        { accountCode: ACC.INGRESOS_VENTAS, credit: 27_778 },
        { accountCode: ACC.INC_POR_PAGAR, credit: 2_222 },
      ],
    });

    expect(saved.totalDebit).toBe(30_000);
    expect(saved.lines.map((l: any) => l.accountCode)).toContain('2495');
  });

  it('inserta solo las cuentas que faltan y no pisa las existentes', async () => {
    await service.listAccounts();

    const codes = db.map((a) => a.code);
    expect(codes).toContain('2408');
    expect(codes).toContain('2495');
    // Sin duplicados: cada código del plan aparece una sola vez.
    expect(new Set(codes).size).toBe(codes.length);
    // La 2367 conserva el nombre que ya tenía: la siembra no renombra.
    expect(db.find((a) => a.code === '2367')?.name).toBe('IVA por pagar');
    const insertados = accounts.bulkWrite.mock.calls[0][0].map(
      (op: any) => op.updateOne.filter.code,
    );
    expect(insertados.sort()).toEqual(['2408', '2495']);
  });

  it('con el plan completo no escribe nada', async () => {
    await service.listAccounts();
    accounts.bulkWrite.mockClear();

    await service.listAccounts();

    expect(accounts.bulkWrite).not.toHaveBeenCalled();
  });

  it('empresa nueva: siembra el plan entero', async () => {
    db = [];

    await service.listAccounts();

    expect(db.map((a) => a.code).sort()).toEqual(
      SEED_ACCOUNTS.map((a) => a.code).sort(),
    );
    expect(db.every((a) => a.system)).toBe(true);
  });
});
