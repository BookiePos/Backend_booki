import { describe, expect, it } from 'vitest';
import { anioColombia, consecutivoDeNumero, nombresArchivo, nombresEntrega } from './nombre-archivo';

describe('nombre de archivo DIAN', () => {
  it('arma prefijo + NIT 10 + PT 3 + año 2 + consecutivo hex 8', () => {
    const n = nombresArchivo({ tipo: 'invoice', nit: '900.123.456', consecutivo: 990000001, anio: 2026 });
    // 990000001 = 0x3b023381
    expect(n.xml).toBe('fv0900123456000263b023381.xml');
    expect(n.zip).toBe('z0900123456000263b023381.zip');
  });

  it('usa el prefijo de cada tipo y el código de PT dado', () => {
    expect(nombresArchivo({ tipo: 'credit_note', nit: '1', consecutivo: 255, anio: 2030, codigoPt: '123' }).xml).toBe(
      'nc000000000112330000000ff.xml',
    );
    expect(nombresArchivo({ tipo: 'debit_note', nit: '1', consecutivo: 1, anio: 2026 }).xml.startsWith('nd')).toBe(true);
    expect(nombresArchivo({ tipo: 'payroll', nit: '1', consecutivo: 1, anio: 2026 }).xml.startsWith('nie')).toBe(true);
  });

  it('el documento equivalente POS usa «ds» (anexo DE v1.0 §8.13.5), con el mismo ZIP «z»', () => {
    const n = nombresArchivo({ tipo: 'pos', nit: '900123456', consecutivo: 1, anio: 2026 });
    expect(n.xml).toBe('ds09001234560002600000001.xml');
    expect(n.zip).toBe('z09001234560002600000001.zip');
  });

  it('valida NIT, consecutivo, año y código PT', () => {
    expect(() => nombresArchivo({ tipo: 'invoice', nit: '', consecutivo: 1, anio: 2026 })).toThrow();
    expect(() => nombresArchivo({ tipo: 'invoice', nit: '12345678901', consecutivo: 1, anio: 2026 })).toThrow();
    expect(() => nombresArchivo({ tipo: 'invoice', nit: '1', consecutivo: 0x1_0000_0000, anio: 2026 })).toThrow();
    expect(() => nombresArchivo({ tipo: 'invoice', nit: '1', consecutivo: -1, anio: 2026 })).toThrow();
    expect(() => nombresArchivo({ tipo: 'invoice', nit: '1', consecutivo: 1, anio: 1999 })).toThrow();
    expect(() => nombresArchivo({ tipo: 'invoice', nit: '1', consecutivo: 1, anio: 2026, codigoPt: '12' })).toThrow();
  });

  it('saca el consecutivo de los dígitos finales del número', () => {
    expect(consecutivoDeNumero('SETP990000001')).toBe(990000001);
    expect(consecutivoDeNumero(' 42 ')).toBe(42);
    expect(() => consecutivoDeNumero('SETP')).toThrow();
    expect(() => consecutivoDeNumero('A99999999999')).toThrow();
  });

  it('el año es el de Colombia (UTC-5)', () => {
    expect(anioColombia(new Date('2027-01-01T03:00:00Z'))).toBe(2026);
    expect(anioColombia(new Date('2027-01-01T06:00:00Z'))).toBe(2027);
  });

  it('entrega al adquiriente: ad…xml y ad…pdf dentro de z…zip, con el mismo cuerpo', () => {
    const n = nombresEntrega({ nit: '900.123.456', consecutivo: 990000001, anio: 2026 });
    expect(n.xml).toBe('ad0900123456000263b023381.xml');
    expect(n.pdf).toBe('ad0900123456000263b023381.pdf');
    expect(n.zip).toBe('z0900123456000263b023381.zip');
  });
});
