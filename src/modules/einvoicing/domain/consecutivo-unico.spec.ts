import { describe, it, expect } from 'vitest';
import {
  INDICE_CONSECUTIVO_UNICO,
  PIPELINE_CONSECUTIVO_DUPLICADO,
  contarConsecutivosDuplicados,
} from './consecutivo-unico';

/**
 * El informe tiene que mirar exactamente lo que entra al índice: si filtrara
 * distinto, diría «sin duplicados» y el índice igual no se crearía.
 */
describe('consecutivo único de electronic_documents', () => {
  it('el índice es único sobre (emisor, prefijo, número)', () => {
    expect(Object.keys(INDICE_CONSECUTIVO_UNICO.keys)).toEqual(['emisor.nit', 'prefix', 'number']);
    expect(INDICE_CONSECUTIVO_UNICO.options.unique).toBe(true);
  });

  it('el informe agrupa con la misma llave y el mismo filtro parcial que el índice', () => {
    expect(PIPELINE_CONSECUTIVO_DUPLICADO[0]).toEqual({
      $match: INDICE_CONSECUTIVO_UNICO.options.partialFilterExpression,
    });
    expect(PIPELINE_CONSECUTIVO_DUPLICADO[1]).toMatchObject({
      $group: { _id: { nit: '$emisor.nit', prefix: '$prefix', number: '$number' } },
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
    expect(c).toEqual({ llavesDuplicadas: 2, documentosSobrantes: 3, indiceCreado: 0 });
    expect(contarConsecutivosDuplicados([], ['consecutivo_unico']).indiceCreado).toBe(1);
  });
});
