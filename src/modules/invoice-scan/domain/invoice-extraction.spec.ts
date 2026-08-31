import { describe, it, expect } from 'vitest';
import {
  normalizeDocNumber,
  parseAmount,
  parseDate,
  parseExtractedInvoice,
} from './invoice-extraction';

/**
 * El parser es la frontera con el modelo: todo lo que entra por aquí es texto
 * que alguien (o algo) pudo escribir mal. Lo que se protege es que **nunca
 * lance** y que **no invente**: un dato ilegible sale como `undefined`, no como
 * un número plausible.
 */
describe('parseAmount', () => {
  it('lee el formato colombiano', () => {
    expect(parseAmount('1.500')).toBe(1500);
    expect(parseAmount('$ 28.800')).toBe(28800);
    expect(parseAmount('1.234.567')).toBe(1234567);
    expect(parseAmount('1.234,56')).toBe(1234.56);
  });

  it('lee también el formato anglosajón que imprimen algunos proveedores', () => {
    expect(parseAmount('1,234,567.89')).toBe(1234567.89);
    expect(parseAmount('2,50')).toBe(2.5);
  });

  it('devuelve undefined en vez de inventar', () => {
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('N/A')).toBeUndefined();
    expect(parseAmount(null)).toBeUndefined();
    expect(parseAmount(undefined)).toBeUndefined();
    expect(parseAmount({})).toBeUndefined();
  });
});

describe('parseDate', () => {
  it('interpreta el día primero, como se escribe en Colombia', () => {
    // 3 de agosto, no 8 de marzo.
    expect(parseDate('03/08/2026')).toBe('2026-08-03');
    expect(parseDate('3-8-26')).toBe('2026-08-03');
  });

  it('acepta ISO tal cual', () => {
    expect(parseDate('2026-08-30')).toBe('2026-08-30');
  });

  it('rechaza fechas imposibles y basura', () => {
    expect(parseDate('45/13/2026')).toBeUndefined();
    expect(parseDate('ayer')).toBeUndefined();
    expect(parseDate(undefined)).toBeUndefined();
  });
});

describe('normalizeDocNumber', () => {
  it('quita puntos y el dígito de verificación', () => {
    expect(normalizeDocNumber('900.123.456-7')).toBe('900123456');
    expect(normalizeDocNumber('900123456')).toBe('900123456');
  });

  it('no recorta una cédula sin guion', () => {
    expect(normalizeDocNumber('1020304050')).toBe('1020304050');
  });

  it('descarta lo que no parece un documento', () => {
    expect(normalizeDocNumber('N/A')).toBeUndefined();
    expect(normalizeDocNumber('12')).toBeUndefined();
  });
});

describe('parseExtractedInvoice', () => {
  it('normaliza una respuesta típica del modelo', () => {
    const result = parseExtractedInvoice({
      supplier: { name: '  Distribuidora El Sol  ', nit: '900.123.456-7' },
      invoice: { numero: 'FV-4821', fecha: '30/08/2026', formaPago: 'Crédito 30 días' },
      lineas: [
        {
          descripcion: 'Gaseosa 350 ml',
          cantidad: '24',
          vrUnitario: '1.200',
          iva: 19,
          total: '28.800',
        },
        { descripcion: 'Transporte', total: '15.000' },
      ],
      totales: { subtotal: '53.800', iva: '5.472', total: '59.272' },
    });

    expect(result.supplier.name).toBe('Distribuidora El Sol');
    expect(result.supplier.docNumber).toBe('900123456');
    expect(result.supplier.docType).toBe('NIT');
    expect(result.invoice.number).toBe('FV-4821');
    expect(result.invoice.issueDate).toBe('2026-08-30');
    expect(result.invoice.paymentTerms).toBe('credito');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({
      description: 'Gaseosa 350 ml',
      qty: 24,
      unitCost: 1200,
      ivaRate: 19,
      lineTotal: 28800,
    });
    expect(result.totals.total).toBe(59272);
  });

  it('aguanta JSON incompleto y basura sin lanzar', () => {
    expect(parseExtractedInvoice(null).lines).toEqual([]);
    expect(parseExtractedInvoice('no soy json').lines).toEqual([]);
    expect(parseExtractedInvoice({ lines: 'tampoco' }).lines).toEqual([]);
    expect(parseExtractedInvoice({ lines: [{ qty: 3 }] }).lines).toEqual([]);
  });

  it('descarta una tarifa de IVA que no existe en Colombia', () => {
    const result = parseExtractedInvoice({
      lines: [{ description: 'Algo', ivaRate: 12 }],
    });
    expect(result.lines[0]?.ivaRate).toBeUndefined();
  });
});
