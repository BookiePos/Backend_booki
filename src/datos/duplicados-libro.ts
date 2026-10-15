import type { PipelineStage } from 'mongoose';
import type { Conteo } from './en-cada-empresa';
import {
  INDICE_ORIGEN_VIVO,
  INDICE_UNA_REVERSA,
} from '../modules/core-ledger/domain/journal-entry.indices';

/**
 * Informe previo a crear los índices únicos del libro (checklist 1.13). Si una
 * empresa ya tiene dos asientos vivos del mismo origen, o dos contra-asientos
 * del mismo asiento, Mongo no crea el índice (Mongoose lo intenta al arrancar y
 * el fallo queda silencioso) y la idempotencia vuelve a depender solo de la
 * búsqueda previa. Solo LEE: cada duplicado se corrige con un contra-asiento,
 * decidido por una persona, nunca borrando el documento.
 */

/**
 * Grupos de asientos vivos con el mismo (sourceType, sourceId). Filtra con
 * `{ campo: null }` (null o ausente) y no con el `$type: 'null'` del índice:
 * así entran también los asientos viejos sin `reversalOf`/`reversedBy`, que
 * quedan dentro del índice en cuanto `COMPLETAR_NULOS` les pone el null.
 */
export const PIPELINE_ORIGEN_DUPLICADO: PipelineStage[] = [
  {
    $match: {
      sourceId: INDICE_ORIGEN_VIVO.options.partialFilterExpression.sourceId,
      reversalOf: null,
      reversedBy: null,
    },
  },
  {
    $group: {
      _id: { sourceType: '$sourceType', sourceId: '$sourceId' },
      n: { $sum: 1 },
      numeros: { $push: '$number' },
    },
  },
  { $match: { n: { $gt: 1 } } },
];

/** Asientos con más de un contra-asiento. */
export const PIPELINE_REVERSA_DUPLICADA: PipelineStage[] = [
  { $match: { ...INDICE_UNA_REVERSA.options.partialFilterExpression } },
  { $group: { _id: '$reversalOf', n: { $sum: 1 }, numeros: { $push: '$number' } } },
  { $match: { n: { $gt: 1 } } },
];

/**
 * Asientos sin `reversalOf` o `reversedBy` guardados: el filtro parcial los
 * deja fuera del índice, así que no los protege. `2026-10-indices-libro.ts`
 * los completa con `COMPLETAR_NULOS` antes de crear los índices.
 */
export const FILTRO_FUERA_DEL_INDICE = {
  $or: [{ reversalOf: { $exists: false } }, { reversedBy: { $exists: false } }],
};

/**
 * Pone `null` explícito donde el campo no existe, el mismo valor que el
 * esquema escribe por defecto. No toca montos, cuentas ni fechas: es la
 * metadata de enlace de la reversa, y sin ella el asiento queda fuera del
 * índice único.
 */
export const COMPLETAR_NULOS = [
  { filter: { reversalOf: { $exists: false } }, update: { $set: { reversalOf: null } } },
  { filter: { reversedBy: { $exists: false } }, update: { $set: { reversedBy: null } } },
] as const;

export interface GrupoDuplicado {
  _id: unknown;
  n: number;
  numeros: string[];
}

export function contarDuplicados(
  origen: GrupoDuplicado[],
  reversas: GrupoDuplicado[],
  fueraDelIndice: number,
  indices: string[],
): Conteo {
  return {
    origenesDuplicados: origen.length,
    asientosSobrantes: origen.reduce((a, g) => a + g.n - 1, 0),
    reversasDuplicadas: reversas.length,
    fueraDelIndice,
    indiceOrigenCreado: indices.includes(INDICE_ORIGEN_VIVO.options.name) ? 1 : 0,
    indiceReversaCreado: indices.includes(INDICE_UNA_REVERSA.options.name) ? 1 : 0,
  };
}

/** Índice no único de la versión anterior, con la misma clave que `origen_vivo_unico`. */
export const INDICE_ORIGEN_VIEJO = 'sourceType_1_sourceId_1';

/**
 * Qué hacer con los índices de una empresa.
 * - Con duplicados (contados como quedarían tras completar los nulos), nada:
 *   se corrigen antes con contra-asientos (ver el informe).
 * - Si hay asientos fuera del índice, se completan con null.
 * - El índice viejo solo se borra si el nuevo de origen no está creado.
 */
export function planIndices(
  conteo: Conteo,
  indices: string[],
):
  | { accion: 'nada' }
  | { accion: 'bloqueado'; motivo: string }
  | { accion: 'aplicar'; completarNulos: boolean; borrarViejo: boolean; crearIndices: boolean } {
  if ((conteo.origenesDuplicados ?? 0) > 0 || (conteo.reversasDuplicadas ?? 0) > 0) {
    return {
      accion: 'bloqueado',
      motivo: 'hay asientos duplicados: corrígelos con contra-asientos (informe de duplicados)',
    };
  }
  const creados = conteo.indiceOrigenCreado === 1 && conteo.indiceReversaCreado === 1;
  const completarNulos = (conteo.fueraDelIndice ?? 0) > 0;
  if (creados && !completarNulos) return { accion: 'nada' };
  return {
    accion: 'aplicar',
    completarNulos,
    borrarViejo: conteo.indiceOrigenCreado !== 1 && indices.includes(INDICE_ORIGEN_VIEJO),
    crearIndices: !creados,
  };
}
