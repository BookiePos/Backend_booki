import { describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { ACC } from '../domain/ledger.constants';
import { lineasNominaCausada, lineasPagoSalarios, type PartesNomina } from './ledger-posting.service';

const debito = (lines: { accountCode: string; debit?: number }[], cuenta: string) =>
  lines.filter((l) => l.accountCode === cuenta).reduce((s, l) => s + (l.debit ?? 0), 0);
const credito = (lines: { accountCode: string; credit?: number }[], cuenta: string) =>
  lines.filter((l) => l.accountCode === cuenta).reduce((s, l) => s + (l.credit ?? 0), 0);

describe('libro · pago quincenal de salarios', () => {
  it('la primera quincena es D 2505 / C caja en efectivo o C bancos por transferencia', () => {
    const efectivo = lineasPagoSalarios(805_417, '10');
    expect(debito(efectivo, ACC.SALARIOS_POR_PAGAR)).toBe(805_417);
    expect(credito(efectivo, ACC.CAJA)).toBe(805_417);
    const banco = lineasPagoSalarios(805_417, '47');
    expect(credito(banco, ACC.BANCOS)).toBe(805_417);
    expect(lineasPagoSalarios(0, '10')).toEqual([]);
  });

  it('el cierre acredita la 2505 por lo que falta pagar más lo de la quincena: el gasto no cambia', () => {
    // Ejemplo de la revisión contable: salario 1.750.905, salud y pensión 140.072.
    const sinQuincena: PartesNomina = {
      neto: 1_610_833,
      seguridadSocialEmpleado: 140_072,
      retencionFuente: 0,
      fiado: 0,
      aportesEmpleador: 0,
      provisiones: 0,
    };
    const conQuincena: PartesNomina = { ...sinQuincena, neto: 805_416, quincena: 805_417 };
    const a = lineasNominaCausada(sinQuincena);
    const b = lineasNominaCausada(conQuincena);
    expect(credito(b, ACC.SALARIOS_POR_PAGAR)).toBe(1_610_833);
    expect(debito(b, ACC.GASTOS_PERSONAL)).toBe(debito(a, ACC.GASTOS_PERSONAL));
    // Pagada la quincena (débito 805.417), la 2505 queda con la segunda quincena.
    expect(credito(b, ACC.SALARIOS_POR_PAGAR) - 805_417).toBe(805_416);
  });

  it('si la quincena superó lo ganado en el mes, el exceso queda a cargo del trabajador (1365)', () => {
    const lines = lineasNominaCausada({
      neto: 0,
      saldoACargoEmpleados: 100_000,
      quincena: 800_000,
      seguridadSocialEmpleado: 56_000,
      retencionFuente: 0,
      fiado: 0,
      aportesEmpleador: 0,
      provisiones: 0,
    });
    expect(credito(lines, ACC.SALARIOS_POR_PAGAR)).toBe(800_000);
    expect(debito(lines, ACC.CXC_TRABAJADORES)).toBe(100_000);
    expect(debito(lines, ACC.GASTOS_PERSONAL)).toBe(756_000);
  });
});
