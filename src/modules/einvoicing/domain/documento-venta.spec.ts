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

  it('una línea con SOLO el tributo 22 (venta sin desglose) aporta 0: el 22 es nominal', () => {
    const sinDesglose = documentoDeVenta({
      total: 3246,
      lines: [
        { name: 'Pan', qty: 1, unitPrice: 3000, lineTotal: 3000 },
        { name: 'Bolsa', qty: 2, unitPrice: 50, lineTotal: 100, bagTaxUnit: 73, bagTax: 146 },
      ],
    });
    expect(sinDesglose.lines.map(primerTributo)).toEqual([undefined, { codigo: '22', taxableAmount: 0 }]);
    expect(sinDesglose.totales.taxExclusiveAmount).toBe(0);
    expect(sinDesglose.totales).toMatchObject({ taxableBase: 3100, bagTaxTotal: 146, payableAmount: 3246 });
  });
});
