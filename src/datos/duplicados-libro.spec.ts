import { describe, it, expect } from 'vitest';
import {
  PIPELINE_ORIGEN_DUPLICADO,
  PIPELINE_REVERSA_DUPLICADA,
  contarDuplicados,
  planIndices,
  INDICE_ORIGEN_VIEJO,
  COMPLETAR_NULOS,
} from './duplicados-libro';
import {
  INDICE_ORIGEN_VIVO,
  INDICE_UNA_REVERSA,
} from '../modules/core-ledger/domain/journal-entry.indices';

/**
 * El informe tiene que mirar exactamente los documentos que entran al índice:
 * si filtrara distinto, diría «sin duplicados» y el índice igual no se crearía.
 */
describe('informe de duplicados del libro', () => {
  it('busca duplicados en lo que entrará al índice, incluidos los asientos sin los campos', () => {
    // Un asiento viejo sin `reversalOf`/`reversedBy` queda fuera del filtro
    // parcial ($type: 'null' no casa con un campo ausente). Al completarlos con
    // null entran al índice: sus duplicados también tienen que salir aquí.
    expect(PIPELINE_ORIGEN_DUPLICADO[0]).toEqual({
      $match: { sourceId: { $type: 'string' }, reversalOf: null, reversedBy: null },
    });
    expect(Object.keys(INDICE_ORIGEN_VIVO.options.partialFilterExpression).sort()).toEqual(
      ['reversalOf', 'reversedBy', 'sourceId'],
    );
    expect(PIPELINE_REVERSA_DUPLICADA[0]).toEqual({
      $match: INDICE_UNA_REVERSA.options.partialFilterExpression,
    });
  });

  it('cuenta grupos, asientos sobrantes e índices presentes', () => {
    const c = contarDuplicados(
      [
        { _id: { sourceType: 'sale', sourceId: 'v1' }, n: 3, numeros: ['AS-1', 'AS-2', 'AS-3'] },
        { _id: { sourceType: 'expense', sourceId: 'g1' }, n: 2, numeros: ['AS-4', 'AS-5'] },
      ],
      [],
      4,
      ['_id_', 'origen_vivo_unico'],
    );
    expect(c).toEqual({
      origenesDuplicados: 2,
      asientosSobrantes: 3,
      reversasDuplicadas: 0,
      fueraDelIndice: 4,
      indiceOrigenCreado: 1,
      indiceReversaCreado: 0,
    });
  });

  describe('plan de índices', () => {
    const base = {
      origenesDuplicados: 0,
      asientosSobrantes: 0,
      reversasDuplicadas: 0,
      fueraDelIndice: 0,
      indiceOrigenCreado: 0,
      indiceReversaCreado: 0,
    };

    it('con los dos índices creados y ningún asiento fuera, no hace nada', () => {
      expect(planIndices({ ...base, indiceOrigenCreado: 1, indiceReversaCreado: 1 }, [])).toEqual({
        accion: 'nada',
      });
    });

    it('con asientos fuera del índice, los completa con null aunque los índices existan', () => {
      expect(
        planIndices(
          { ...base, indiceOrigenCreado: 1, indiceReversaCreado: 1, fueraDelIndice: 3 },
          [],
        ),
      ).toEqual({ accion: 'aplicar', completarNulos: true, borrarViejo: false, crearIndices: false });
    });

    it('completar nulos solo toca los asientos que no tienen el campo', () => {
      expect(COMPLETAR_NULOS).toEqual([
        { filter: { reversalOf: { $exists: false } }, update: { $set: { reversalOf: null } } },
        { filter: { reversedBy: { $exists: false } }, update: { $set: { reversedBy: null } } },
      ]);
    });

    it('con duplicados no toca nada: el índice no se crearía igual', () => {
      expect(
        planIndices({ ...base, origenesDuplicados: 1 }, [INDICE_ORIGEN_VIEJO]).accion,
      ).toBe('bloqueado');
    });

    it('sin duplicados y sin el nuevo, borra el viejo (si está) y crea los nuevos', () => {
      expect(planIndices(base, ['_id_', INDICE_ORIGEN_VIEJO])).toEqual({
        accion: 'aplicar',
        completarNulos: false,
        borrarViejo: true,
        crearIndices: true,
      });
      expect(planIndices({ ...base, indiceOrigenCreado: 1 }, [INDICE_ORIGEN_VIEJO])).toEqual({
        accion: 'aplicar',
        completarNulos: false,
        borrarViejo: false,
        crearIndices: true,
      });
    });
  });
});
