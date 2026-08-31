import { describe, it, expect } from 'vitest';
import { proposeLineTarget, qtyFitsPurchaseLine } from './line-classification';
import { similarity } from './text-normalize';

/**
 * La clasificación decide si un renglón entra al inventario o se registra como
 * gasto. Equivocarse aquí no rompe nada —la persona lo corrige en la revisión—
 * pero cada acierto es un clic menos, y el caso del flete es el que aparece en
 * casi todas las facturas.
 */
describe('proposeLineTarget', () => {
  it('manda a inventario lo que tiene cantidad y valor unitario', () => {
    const { target } = proposeLineTarget({
      description: 'Gaseosa 350 ml',
      qty: 24,
      unitCost: 1200,
    });
    expect(target).toBe('inventory');
  });

  it('manda a gasto los conceptos que no son mercancía', () => {
    for (const description of [
      'Transporte',
      'Flete urbano',
      'Servicio de instalación',
      'Domicilio',
      'Recargo por manejo',
    ]) {
      expect(proposeLineTarget({ description, lineTotal: 15000 }).target).toBe(
        'expense',
      );
    }
  });

  it('manda a gasto lo que no trae ni cantidad ni valor unitario', () => {
    expect(proposeLineTarget({ description: 'Concepto suelto' }).target).toBe(
      'expense',
    );
  });

  it('ignora los renglones de totales y descuentos', () => {
    expect(proposeLineTarget({ description: 'Subtotal' }).target).toBe('ignore');
    expect(proposeLineTarget({ description: 'Descuento comercial' }).target).toBe(
      'ignore',
    );
  });

  it('no confunde un producto que contiene una palabra de gasto', () => {
    // "Aceite de servicio pesado" es mercancía, no un servicio.
    const { target } = proposeLineTarget({
      description: 'Aceite 20W50',
      qty: 6,
      unitCost: 32000,
    });
    expect(target).toBe('inventory');
  });
});

describe('qtyFitsPurchaseLine', () => {
  it('acepta enteros positivos, que es lo que admite una orden de compra', () => {
    expect(qtyFitsPurchaseLine(1)).toBe(true);
    expect(qtyFitsPurchaseLine(24)).toBe(true);
  });

  it('rechaza decimales en vez de redondear por su cuenta', () => {
    // Redondear 2,5 kg a 3 falsearía el inventario en silencio.
    expect(qtyFitsPurchaseLine(2.5)).toBe(false);
    expect(qtyFitsPurchaseLine(0)).toBe(false);
    expect(qtyFitsPurchaseLine(undefined)).toBe(false);
  });
});

describe('similarity', () => {
  it('empareja la misma cosa escrita distinto', () => {
    expect(
      similarity('GASEOSA POSTOBON 350ML', 'Gaseosa Postobón 350 ml'),
    ).toBeGreaterThan(0.6);
  });

  it('no empareja productos distintos de la misma familia', () => {
    expect(similarity('Arroz Diana 500 g', 'Arroz Roa 1000 g')).toBeLessThan(0.6);
  });
});
