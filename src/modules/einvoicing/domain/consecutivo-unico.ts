import type { PipelineStage } from 'mongoose';

/**
 * NIT base normalizado: solo dígitos y sin DV. Si trae guion, vale lo de antes
 * del guion ('900.123.456-7' -> '900123456'); si no, todos los dígitos.
 *
 * AMBIGUEDAD: un NIT de 10 dígitos SIN guion puede ser 9 dígitos + DV pegado
 * ('9001234567') o un NIT de 10 dígitos (personas jurídicas nuevas). No se puede
 * distinguir sin el DV aparte, así que se conservan los 10: el mismo NIT escrito
 * con y sin DV pegado no se detecta como igual (se pierde un duplicado, nunca se
 * inventa uno). Por eso conviene capturar el DV en `nitDv` y el NIT sin él.
 */
export function normalizarNit(nit?: string | null): string | undefined {
  if (!nit) return undefined;
  const texto = String(nit).trim();
  const base = texto.includes('-') ? texto.split('-')[0] ?? '' : texto;
  const digitos = base.replace(/\D/g, '');
  return digitos || undefined;
}

/**
 * Índice único del consecutivo de `electronic_documents`: (emisor, prefijo,
 * número), SIN el tipo de documento: la DIAN rechaza dos documentos del mismo
 * facturador con el mismo prefijo y número aunque sean de tipo distinto. Por eso
 * las resoluciones que no son de factura exigen un prefijo propio (ver
 * `registerResolution`): sin prefijo chocarían con la factura.
 *
 * EMISOR: la colección `fiscal_emitters` todavía no existe. Mientras tanto el
 * facturador es el NIT normalizado congelado en cada documento
 * (`emisor.nitNorm`). TODO(emisorId): cuando exista el emisor como colección,
 * la llave pasa a `emisorId` y este archivo es el único sitio a cambiar, junto
 * con el pipeline del informe y el script de relleno.
 *
 * Parcial: los documentos sin `nitNorm` (viejos, hasta que corra el relleno)
 * quedarían todos con la misma llave nula y se bloquearían entre sí.
 */
export const INDICE_CONSECUTIVO_UNICO = {
  keys: { 'emisor.nitNorm': 1, prefix: 1, number: 1 },
  options: {
    name: 'consecutivo_unico',
    unique: true,
    partialFilterExpression: { 'emisor.nitNorm': { $type: 'string' } },
  },
} as const;

/**
 * Campo de la exclusión POS/FEV (D1, Fase 7): el `saleId` de la venta en los
 * documentos `pos` e `invoice` vigentes. Un índice único sobre él impide que una
 * misma venta tenga POS y FEV a la vez.
 *
 * Es un campo aparte, y no un parcial `{ type: { $in: [...] } }` sobre `saleId`,
 * porque el filtro parcial con `$in`/`$ne` no lo admiten todas las versiones de
 * Mongo, y porque así «anular» (nota de ajuste de anulación, Fase 6) es solo
 * quitar el campo: el documento anulado deja de bloquear la FEV que lo
 * reemplaza sin que haya que borrarlo.
 */
export const CAMPO_EXCLUSION_FISCAL = 'ventaFiscal';

/** Tipos de documento que se excluyen entre sí por venta. */
export const TIPOS_EXCLUYENTES_POR_VENTA = ['pos', 'invoice'] as const;

export const INDICE_EXCLUSION_FISCAL = {
  keys: { [CAMPO_EXCLUSION_FISCAL]: 1 },
  options: {
    name: 'documento_fiscal_por_venta',
    unique: true,
    partialFilterExpression: { [CAMPO_EXCLUSION_FISCAL]: { $exists: true } },
  },
} as const;

/**
 * Expresión de agregación que calcula el NIT normalizado a partir de
 * `emisor.nit` (misma regla que `normalizarNit`), para cubrir los documentos
 * viejos que no tienen `nitNorm`. Devuelve null si no hay dígitos.
 */
export const EXPR_NIT_NORM = {
  $let: {
    vars: {
      digitos: {
        $reduce: {
          input: {
            $regexFindAll: {
              input: { $arrayElemAt: [{ $split: ['$emisor.nit', '-'] }, 0] },
              regex: '\\d+',
            },
          },
          initialValue: '',
          in: { $concat: ['$$value', '$$this.match'] },
        },
      },
    },
    in: { $cond: [{ $eq: ['$$digitos', ''] }, null, '$$digitos'] },
  },
};

/** Grupos de documentos que repiten (emisor, prefijo, número): impiden crear el índice. */
export const PIPELINE_CONSECUTIVO_DUPLICADO: PipelineStage[] = [
  { $match: { 'emisor.nit': { $type: 'string' } } },
  { $addFields: { _nitNorm: { $ifNull: ['$emisor.nitNorm', EXPR_NIT_NORM] } } },
  { $match: { _nitNorm: { $type: 'string' } } },
  {
    $group: {
      _id: { nit: '$_nitNorm', prefix: '$prefix', number: '$number' },
      n: { $sum: 1 },
      documentos: { $push: '$fullNumber' },
    },
  },
  { $match: { n: { $gt: 1 } } },
] as PipelineStage[];

/** Documentos con NIT pero sin `nitNorm`: el script de relleno los completa. */
export const FILTRO_SIN_NIT_NORM = {
  'emisor.nit': { $type: 'string' },
  'emisor.nitNorm': { $exists: false },
} as const;

export interface GrupoConsecutivoDuplicado {
  _id: { nit: string; prefix?: string | null; number: number };
  n: number;
  documentos: string[];
}

/** Cifras del informe: cuántas llaves repetidas y cuántos documentos sobran. */
export function contarConsecutivosDuplicados(
  grupos: GrupoConsecutivoDuplicado[],
  indices: string[],
  sinNitNorm = 0,
): Record<string, number> {
  return {
    llavesDuplicadas: grupos.length,
    documentosSobrantes: grupos.reduce((a, g) => a + g.n - 1, 0),
    sinNitNorm,
    indiceCreado: indices.includes(INDICE_CONSECUTIVO_UNICO.options.name) ? 1 : 0,
  };
}

/**
 * Qué choque de E11000 es, para decidir qué hacer al emitir:
 * - 'consecutivo': el número ya existe para (NIT, prefijo) -> subir el contador.
 * - 'venta': ya hay un documento de esa venta y tipo (doble emisión) -> devolverlo.
 * - 'exclusion': la venta ya tiene su documento fiscal (POS o FEV, D1 de la
 *   Fase 7) -> el mismo tipo se devuelve; el otro es un 409.
 * - null: no es un duplicado de índice, o no se reconoce.
 */
export function tipoDeChoque(
  err: unknown,
): 'consecutivo' | 'venta' | 'exclusion' | null {
  const e = err as {
    code?: number;
    keyPattern?: Record<string, unknown>;
    message?: string;
  } | null;
  if (!e || e.code !== 11000) return null;
  const claves = Object.keys(e.keyPattern ?? {});
  if (claves.includes('number') || claves.includes('emisor.nitNorm')) return 'consecutivo';
  if (claves.includes(CAMPO_EXCLUSION_FISCAL)) return 'exclusion';
  if (claves.includes('saleId')) return 'venta';
  const msg = e.message ?? '';
  if (msg.includes('consecutivo_unico')) return 'consecutivo';
  if (msg.includes('saleId_1_type_1')) return 'venta';
  if (msg.includes(INDICE_EXCLUSION_FISCAL.options.name)) return 'exclusion';
  return null;
}
