import { describe, it, expect } from 'vitest';
import {
  expectedByDay,
  mergeSettlementItems,
  parseCopAmount,
  parseStatementCsv,
  reconKey,
  settlementDifference,
} from './payment-reconciliation';

const dia = (d: Date) => d.toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T15:00:00Z`);

describe('expectedByDay', () => {
  it('agrupa por día y canal, datáfono por franquicia, y deja fuera efectivo y fiado', () => {
    const rows = expectedByDay(
      [
        { total: 50_000, createdAt: at('2026-10-20'), payment: { method: 'cash' } },
        {
          total: 30_000,
          tip: 3_000,
          createdAt: at('2026-10-20'),
          payment: { method: 'card', channel: 'datafono', franchise: 'visa' },
        },
        {
          total: 20_000,
          createdAt: at('2026-10-20'),
          payment: { method: 'card', channel: 'datafono', franchise: 'mastercard' },
        },
        {
          total: 100_000,
          createdAt: at('2026-10-21'),
          payments: [
            { method: 'cash', amount: 40_000 },
            { method: 'transfer', amount: 35_000, channel: 'nequi' },
            { method: 'transfer', amount: 25_000, channel: 'daviplata' },
          ],
        },
        { total: 9_000, createdAt: at('2026-10-21'), payment: { method: 'credit' } },
        { total: 8_000, createdAt: at('2026-10-21'), payment: { method: 'card' } },
      ],
      dia,
    );
    const pick = (date: string, key: string) =>
      rows.find((r) => r.date === date && r.key === key);
    expect(pick('2026-10-20', 'datafono:visa')?.expected).toBe(33_000);
    expect(pick('2026-10-20', 'datafono:mastercard')?.expected).toBe(20_000);
    expect(pick('2026-10-21', 'nequi')?.expected).toBe(35_000);
    expect(pick('2026-10-21', 'daviplata')?.expected).toBe(25_000);
    // Una tarjeta sin canal (antes del 6.4) cuenta como datáfono sin franquicia.
    expect(pick('2026-10-21', 'datafono')?.expected).toBe(8_000);
    expect(rows).toHaveLength(5);
  });
});

describe('settlementDifference', () => {
  it('cuadra cuando consignado + comisión + IVA + retenciones = cobrado', () => {
    expect(
      settlementDifference({
        expected: 100_000,
        statementAmount: 95_000,
        commission: 3_000,
        commissionIva: 570,
        retefuente: 1_000,
        reteIca: 300,
        reteIva: 130,
      }),
    ).toBe(0);
  });

  it('muestra lo que falta o sobra', () => {
    const f = {
      expected: 100_000,
      commission: 0,
      commissionIva: 0,
      retefuente: 0,
      reteIca: 0,
      reteIva: 0,
    };
    expect(settlementDifference({ ...f, statementAmount: 97_000 })).toBe(3_000);
    expect(settlementDifference({ ...f, statementAmount: 101_000 })).toBe(-1_000);
  });
});

describe('parseCopAmount', () => {
  it.each([
    ['1.234.567', 1_234_567],
    ['1,234,567', 1_234_567],
    ['$ 98.500', 98_500],
    ['1234567,00', 1_234_567],
    ['', 0],
  ])('%s -> %s', (raw, n) => expect(parseCopAmount(raw)).toBe(n));
  it('rechaza texto', () => expect(parseCopAmount('abc')).toBeNull());
});

describe('parseStatementCsv', () => {
  it('lee un extracto con punto y coma, franquicia y descuentos', () => {
    const r = parseStatementCsv(
      'Fecha;Franquicia;Bruto;Comisión;IVA;ReteFuente;ReteICA;ReteIVA\n' +
        '20/10/2026;Visa;"100.000";3.000;570;1.000;300;130\n' +
        '2026-10-21;Mastercard;50.000;1.500;285;0;0;0\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      date: '2026-10-20',
      channel: 'datafono',
      franchise: 'visa',
      commission: 3_000,
      statementAmount: 95_000,
    });
    expect(reconKey(r.rows[0]!.channel, r.rows[0]!.franchise)).toBe('datafono:visa');
    expect(r.rows[1]!.statementAmount).toBe(48_215);
  });

  it('usa el canal por omisión y el neto del extracto si viene', () => {
    const r = parseStatementCsv('fecha,neto\n2026-10-20,"45,000"\n', 'nequi');
    expect(r.rows).toEqual([
      expect.objectContaining({ channel: 'nequi', statementAmount: 45_000 }),
    ]);
  });

  it('reporta las filas malas sin tumbar las buenas', () => {
    const r = parseStatementCsv(
      'fecha,canal,neto\nayer,nequi,1000\n2026-10-20,nada,1000\n2026-10-20,qr,2000\n',
    );
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
  });

  it('pide las columnas mínimas', () => {
    expect(parseStatementCsv('a,b\n1,2\n').errors[0]!.message).toMatch(/Faltan columnas/);
  });
});

describe('mergeSettlementItems (varias filas del mismo día y canal)', () => {
  it('suma por fecha|clave y conserva el orden de aparición', () => {
    const r = mergeSettlementItems([
      { date: '2026-10-20', channel: 'datafono', franchise: 'visa', statementAmount: 1000, commission: 10 },
      { date: '2026-10-20', channel: 'nequi', statementAmount: 500 },
      { date: '2026-10-20', channel: 'datafono', franchise: 'visa', statementAmount: 2000, commission: 20, retefuente: 5 },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ channel: 'datafono', statementAmount: 3000, commission: 30, retefuente: 5 });
    expect(r[1]).toMatchObject({ channel: 'nequi', statementAmount: 500 });
  });

  it('el datáfono sin franquicia no se mezcla con el de Visa', () => {
    const r = mergeSettlementItems([
      { date: '2026-10-20', channel: 'datafono', franchise: 'visa', statementAmount: 1 },
      { date: '2026-10-20', channel: 'datafono', statementAmount: 2 },
    ]);
    expect(r).toHaveLength(2);
  });
});
