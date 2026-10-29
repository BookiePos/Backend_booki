import type { PipelineStage } from 'mongoose';

/**
 * Índice único del consecutivo de `electronic_documents`: (emisor, prefijo,
 * número). La DIAN rechaza dos documentos del mismo facturador con el mismo
 * prefijo y número, y hoy nada lo impide a nivel de base: el contador es por
 * sede, así que dos sedes con el mismo NIT y prefijo emitirían el mismo número.
 *
 * EMISOR: la colección `fiscal_emitters` todavía no existe. Mientras tanto el
 * facturador es el NIT congelado en cada documento (`emisor.nit`).
 * TODO(emisorId): cuando exista el emisor como colección, la llave pasa a
 * `emisorId` (checklist 1 de la Fase 1) y este archivo es el único sitio a
 * cambiar, junto con el pipeline del informe.
 *
 * Parcial: los documentos sin NIT (borradores viejos sin emisor) quedarían
 * todos con la misma llave nula y se bloquearían entre sí.
 */
export const INDICE_CONSECUTIVO_UNICO = {
  keys: { 'emisor.nit': 1, prefix: 1, number: 1 },
  options: {
    name: 'consecutivo_unico',
    unique: true,
    partialFilterExpression: { 'emisor.nit': { $type: 'string' } },
  },
} as const;

/** Grupos de documentos que repiten (emisor, prefijo, número): impiden crear el índice. */
export const PIPELINE_CONSECUTIVO_DUPLICADO: PipelineStage[] = [
  { $match: { 'emisor.nit': { $type: 'string' } } },
  {
    $group: {
      _id: { nit: '$emisor.nit', prefix: '$prefix', number: '$number' },
      n: { $sum: 1 },
      documentos: { $push: '$fullNumber' },
    },
  },
  { $match: { n: { $gt: 1 } } },
];

export interface GrupoConsecutivoDuplicado {
  _id: { nit: string; prefix?: string | null; number: number };
  n: number;
  documentos: string[];
}

/** Cifras del informe: cuántas llaves repetidas y cuántos documentos sobran. */
export function contarConsecutivosDuplicados(
  grupos: GrupoConsecutivoDuplicado[],
  indices: string[],
): Record<string, number> {
  return {
    llavesDuplicadas: grupos.length,
    documentosSobrantes: grupos.reduce((a, g) => a + g.n - 1, 0),
    indiceCreado: indices.includes(INDICE_CONSECUTIVO_UNICO.options.name) ? 1 : 0,
  };
}
