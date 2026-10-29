import { describe, it, expect } from 'vitest';
import {
  INDICE_CONSECUTIVO_UNICO,
  normalizarNit,
  tipoDeChoque,
  PIPELINE_CONSECUTIVO_DUPLICADO,
  contarConsecutivosDuplicados,
} from './consecutivo-unico';

/**
 * El informe tiene que mirar exactamente lo que entra al índice: si filtrara
 * distinto, diría «sin duplicados» y el índice igual no se crearía.
 */
describe('consecutivo único de electronic_documents', () => {
  it('el índice es único sobre (emisor, prefijo, número)', () => {
    expect(Object.keys(INDICE_CONSECUTIVO_UNICO.keys)).toEqual(['emisor.nitNorm', 'prefix', 'number']);
    expect(INDICE_CONSECUTIVO_UNICO.options.unique).toBe(true);
  });

  it('el informe agrupa con la misma llave y el mismo filtro parcial que el índice', () => {
    // Normaliza a partir de emisor.nit si falta nitNorm, y filtra como el índice.
    expect(PIPELINE_CONSECUTIVO_DUPLICADO[2]).toEqual({
      $match: { _nitNorm: { $type: 'string' } },
    });
    expect(PIPELINE_CONSECUTIVO_DUPLICADO[3]).toMatchObject({
      $group: { _id: { nit: '$_nitNorm', prefix: '$prefix', number: '$number' } },
    });
  });

  it('cuenta llaves repetidas, documentos sobrantes y si el índice ya existe', () => {
    const c = contarConsecutivosDuplicados(
      [
        { _id: { nit: '900', prefix: 'FE', number: 5 }, n: 3, documentos: ['FE5', 'FE5', 'FE5'] },
        { _id: { nit: '900', prefix: 'NC', number: 1 }, n: 2, documentos: ['NC1', 'NC1'] },
      ],
      ['_id_'],
    );
    expect(c).toEqual({ llavesDuplicadas: 2, documentosSobrantes: 3, sinNitNorm: 0, indiceCreado: 0 });
    expect(contarConsecutivosDuplicados([], ['consecutivo_unico']).indiceCreado).toBe(1);
  });
});

describe('normalizarNit', () => {
  it('con guion toma lo de antes; sin guion, todos los dígitos', () => {
    expect(normalizarNit('900.123.456-7')).toBe('900123456');
    expect(normalizarNit(' 900123456 - 7 ')).toBe('900123456');
    expect(normalizarNit('900123456')).toBe('900123456');
  });

  it('NIT de 10 dígitos sin guion: ambiguo, se conservan los 10', () => {
    expect(normalizarNit('9001234567')).toBe('9001234567');
  });

  it('sin dígitos o vacío no hay NIT', () => {
    expect(normalizarNit('')).toBeUndefined();
    expect(normalizarNit(undefined)).toBeUndefined();
    expect(normalizarNit('N/A')).toBeUndefined();
  });
});

describe('tipoDeChoque', () => {
  it('distingue el choque de número del de venta+tipo', () => {
    expect(tipoDeChoque({ code: 11000, keyPattern: { 'emisor.nitNorm': 1, prefix: 1, number: 1 } })).toBe('consecutivo');
    expect(tipoDeChoque({ code: 11000, keyPattern: { saleId: 1, type: 1 } })).toBe('venta');
    expect(tipoDeChoque({ code: 11000, message: 'index: consecutivo_unico dup key' })).toBe('consecutivo');
  });

  it('lo que no es E11000 no es un choque', () => {
    expect(tipoDeChoque(new Error('x'))).toBeNull();
    expect(tipoDeChoque({ code: 11000 })).toBeNull();
    expect(tipoDeChoque(null)).toBeNull();
  });
});
