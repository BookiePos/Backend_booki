import { describe, expect, it } from 'vitest';
import { documentoDeVenta, primerTributo } from './documento-venta';

describe('primerTributo (FAU04)', () => {
  const doc = documentoDeVenta({
    total: 15546,
    lines: [
      { name: 'Hamburguesa', qty: 1, unitPrice: 10000, lineTotal: 10000, taxKind: 'inc', taxRate: 8, taxBase: 9259, taxAmount: 741 },
      { name: 'Bolsa', qty: 2, unitPrice: 100, lineTotal: 200, taxKind: 'iva', taxRate: 19, taxBase: 168, taxAmount: 32, bagTaxUnit: 73, bagTax: 146 },
      { name: 'Arroz', qty: 1, unitPrice: 5200, lineTotal: 5200, taxKind: 'iva', taxRate: 0, taxTreatment: 'excluido', taxBase: 5200, taxAmount: 0 },
    ],
  });

  it('el ad valorem va primero; el 22 de la bolsa, después; sin tributo no hay', () => {
    expect(doc.lines.map(primerTributo)).toEqual([
      { codigo: '04', taxableAmount: 9259 },
      { codigo: '01', taxableAmount: 168 },
      undefined,
    ]);
  });

  it('TaxExclusiveAmount es exactamente la suma de esos TaxableAmount', () => {
    expect(doc.totales.taxExclusiveAmount).toBe(9259 + 168);
  });
});
