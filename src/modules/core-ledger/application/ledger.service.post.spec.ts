import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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
import { ACC } from '../domain/ledger.constants';

/**
 * `post` es la ÚNICA puerta de escritura del libro diario, así que es la única
 * defensa contra un libro descuadrado. Aquí se fija lo que tiene que rechazar.
 *
 * Y `reverse` es la única forma de deshacer: un asiento no se edita jamás, se
 * contrapone con otro que intercambia los lados. Si esa reversa no fuera exacta,
 * anular una venta dejaría un residuo permanente en el balance.
 */
describe('LedgerService · escritura del libro diario', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';

  let accounts: any;
  let entries: any;
  let service: LedgerService;

  /** Cuentas que el doble de `accounts` dice conocer. */
  function knownAccounts(codes: string[]) {
    return codes.map((code) => ({ code, name: `Cuenta ${code}` }));
  }

  beforeEach(() => {
    accounts = {
      countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(1) })),
      find: vi.fn(() => ({
        exec: () =>
          Promise.resolve(
            knownAccounts([
              ACC.CAJA,
              ACC.BANCOS,
              ACC.INGRESOS_VENTAS,
              ACC.IVA_POR_PAGAR,
            ]),
          ),
      })),
      insertMany: vi.fn(),
    };
    entries = {
      estimatedDocumentCount: vi.fn(() => ({ exec: () => Promise.resolve(0) })),
      create: vi.fn((doc: unknown) => Promise.resolve(doc)),
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    service = new LedgerService(accounts as never, entries as never);
  });

  const entrada = {
    date: '2026-09-10',
    sourceType: 'manual',
    memo: 'Prueba',
  };

  it('acepta un asiento cuadrado y guarda los totales', async () => {
    const saved: any = await service.post({
      ...entrada,
      lines: [
        { accountCode: ACC.CAJA, debit: 119_000, sedeId: SEDE },
        { accountCode: ACC.INGRESOS_VENTAS, credit: 100_000, sedeId: SEDE },
        { accountCode: ACC.IVA_POR_PAGAR, credit: 19_000, sedeId: SEDE },
      ],
    });

    expect(saved.totalDebit).toBe(119_000);
    expect(saved.totalCredit).toBe(119_000);
    expect(saved.number).toBe('AS-000001');
  });

  it('rechaza un asiento descuadrado, aunque sea por un peso', async () => {
    await expect(
      service.post({
        ...entrada,
        lines: [
          { accountCode: ACC.CAJA, debit: 100_001 },
          { accountCode: ACC.INGRESOS_VENTAS, credit: 100_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(entries.create).not.toHaveBeenCalled();
  });

  it('rechaza un renglón con débito Y crédito a la vez', async () => {
    await expect(
      service.post({
        ...entrada,
        lines: [
          { accountCode: ACC.CAJA, debit: 50_000, credit: 50_000 },
          { accountCode: ACC.INGRESOS_VENTAS, credit: 50_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un renglón en cero: no aporta nada y ensucia el asiento', async () => {
    await expect(
      service.post({
        ...entrada,
        lines: [
          { accountCode: ACC.CAJA, debit: 50_000 },
          { accountCode: ACC.INGRESOS_VENTAS, credit: 50_000 },
          { accountCode: ACC.BANCOS },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza montos negativos: un cargo negativo es un abono disfrazado', async () => {
    await expect(
      service.post({
        ...entrada,
        lines: [
          { accountCode: ACC.CAJA, debit: -50_000 },
          { accountCode: ACC.INGRESOS_VENTAS, credit: -50_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un asiento de un solo renglón: la partida es doble', async () => {
    await expect(
      service.post({
        ...entrada,
        lines: [{ accountCode: ACC.CAJA, debit: 50_000 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza cuentas que no existen en el plan', async () => {
    await expect(
      service.post({
        ...entrada,
        lines: [
          { accountCode: '9999', debit: 50_000 },
          { accountCode: ACC.INGRESOS_VENTAS, credit: 50_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('redondea a peso entero antes de comparar los lados', async () => {
    // 33.333,4 y 33.333,3 redondean al mismo peso: el asiento cuadra.
    const saved: any = await service.post({
      ...entrada,
      lines: [
        { accountCode: ACC.CAJA, debit: 33_333.4 },
        { accountCode: ACC.INGRESOS_VENTAS, credit: 33_333.3 },
      ],
    });

    expect(saved.totalDebit).toBe(33_333);
    expect(saved.totalCredit).toBe(33_333);
  });

  describe('reversa', () => {
    /** Asiento original ya guardado, listo para contraponer. */
    function original() {
      return {
        _id: 'as1',
        number: 'AS-000001',
        sourceType: 'sale',
        sourceId: 's1',
        memo: 'Venta FV-000001',
        lines: [
          { accountCode: ACC.CAJA, accountName: 'Caja', debit: 119_000, credit: 0 },
          {
            accountCode: ACC.INGRESOS_VENTAS,
            accountName: 'Ingresos',
            debit: 0,
            credit: 100_000,
          },
          {
            accountCode: ACC.IVA_POR_PAGAR,
            accountName: 'IVA',
            debit: 0,
            credit: 19_000,
          },
        ],
        totalDebit: 119_000,
        totalCredit: 119_000,
        reversalOf: null,
        reversedBy: null as unknown,
        save: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('intercambia los lados renglón por renglón y sigue cuadrando', async () => {
      const orig = original();
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(orig) });
      entries.create.mockImplementation((doc: any) =>
        Promise.resolve({ ...doc, _id: 'as2' }),
      );

      const contra: any = await service.reverse('as1');

      expect(contra.totalDebit).toBe(119_000);
      expect(contra.totalCredit).toBe(119_000);
      const caja = contra.lines.find((l: any) => l.accountCode === ACC.CAJA);
      expect(caja.debit).toBe(0);
      expect(caja.credit).toBe(119_000);
      const ingresos = contra.lines.find(
        (l: any) => l.accountCode === ACC.INGRESOS_VENTAS,
      );
      expect(ingresos.debit).toBe(100_000);
      expect(ingresos.credit).toBe(0);
    });

    it('marca el original como reversado para no poder reversarlo dos veces', async () => {
      const orig = original();
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(orig) });
      entries.create.mockImplementation((doc: any) =>
        Promise.resolve({ ...doc, _id: 'as2' }),
      );

      await service.reverse('as1');

      expect(orig.reversedBy).toBe('as2');
      expect(orig.save).toHaveBeenCalledOnce();
    });

    it('no reversa un asiento ya reversado', async () => {
      const orig = original();
      orig.reversedBy = 'as2';
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(orig) });

      await expect(service.reverse('as1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('no reversa un contra-asiento: se acabaría en un ping-pong infinito', async () => {
      const orig = original();
      orig.reversalOf = 'as0' as never;
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(orig) });

      await expect(service.reverse('as1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
