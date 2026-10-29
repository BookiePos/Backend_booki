import { describe, expect, it } from 'vitest';
import {
  calcularDvNit,
  dvNitValido,
  errorDvCliente,
  separarNitConDv,
} from './datos-fiscales';

describe('calcularDvNit', () => {
  it.each([
    ['860002964', 4], // Banco de Bogotá
    ['890903938', 8], // Bancolombia
    ['800197268', 4], // DIAN
    ['860034313', 7], // Davivienda
    ['890900608', 9], // Almacenes Éxito
  ])('NIT %s -> DV %i', (nit, dv) => {
    expect(calcularDvNit(nit)).toBe(dv);
  });

  it('el DV siempre es un dígito', () => {
    for (let n = 1; n < 500; n++) {
      const dv = calcularDvNit(String(n))!;
      expect(dv).toBeGreaterThanOrEqual(0);
      expect(dv).toBeLessThanOrEqual(9);
    }
  });

  it('rechaza lo que no son dígitos o es demasiado largo', () => {
    expect(calcularDvNit('90012345A')).toBeUndefined();
    expect(calcularDvNit('')).toBeUndefined();
    expect(calcularDvNit('1234567890123456')).toBeUndefined();
  });
});

describe('dvNitValido', () => {
  it('acepta número o texto', () => {
    expect(dvNitValido('860002964', 4)).toBe(true);
    expect(dvNitValido('860002964', '4')).toBe(true);
    expect(dvNitValido('860002964', '5')).toBe(false);
  });
});

describe('separarNitConDv', () => {
  it('separa con guion', () => {
    expect(separarNitConDv('860.002.964-4')).toEqual({
      base: '860002964',
      dv: '4',
    });
  });
  it('sin guion no inventa DV', () => {
    expect(separarNitConDv('8600029644')).toEqual({ base: '8600029644' });
  });
  it('vacío', () => {
    expect(separarNitConDv('')).toBeUndefined();
    expect(separarNitConDv('abc')).toBeUndefined();
  });
});

describe('errorDvCliente', () => {
  it('no aplica si no es NIT', () => {
    expect(
      errorDvCliente({ dianDocType: '13', docNumber: '123' }),
    ).toBeUndefined();
    expect(errorDvCliente({ docType: 'CC', docNumber: '123' })).toBeUndefined();
  });
  it('DV correcto en campo aparte o con guion', () => {
    expect(
      errorDvCliente({ dianDocType: '31', docNumber: '860002964', nitDv: '4' }),
    ).toBeUndefined();
    expect(
      errorDvCliente({ docType: 'NIT', docNumber: '860.002.964-4' }),
    ).toBeUndefined();
  });
  it('DV incorrecto dice qué campo corregir', () => {
    const msg = errorDvCliente({
      dianDocType: '31',
      docNumber: '860002964',
      nitDv: '5',
    });
    expect(msg).toContain('debería ser 4');
    expect(msg).toContain('«DV»');
  });
  it('NIT DIAN sin DV pide el campo', () => {
    expect(
      errorDvCliente({ dianDocType: '31', docNumber: '860002964' }),
    ).toContain('Falta el dígito de verificación');
  });
  it('NIT legado sin DV no se rechaza (no rompe clientes existentes)', () => {
    expect(
      errorDvCliente({ docType: 'NIT', docNumber: '860002964' }),
    ).toBeUndefined();
  });
});
