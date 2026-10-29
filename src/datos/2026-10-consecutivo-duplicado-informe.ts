import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  FILTRO_SIN_NIT_NORM,
  PIPELINE_CONSECUTIVO_DUPLICADO,
  contarConsecutivosDuplicados,
  type GrupoConsecutivoDuplicado,
} from '../modules/einvoicing/domain/consecutivo-unico';
import {
  ElectronicDocument,
  type ElectronicDocumentDocument,
} from '../modules/einvoicing/infrastructure/schemas/electronic-document.schema';

/**
 * Por qué existe (checklist 1, Fase 1): antes de que el índice único
 * `consecutivo_unico` (emisor, prefijo, número) de `electronic_documents` quede
 * creado en producción, lista los documentos que repiten esa llave y dice si el
 * índice ya existe. SOLO LEE: `--aplicar` falla a propósito. Un documento
 * electrónico duplicado ya pudo salir a la DIAN, así que se resuelve a mano
 * (anular o renumerar con criterio), nunca borrando por script.
 *
 * Normaliza el NIT desde `emisor.nit` (misma regla que `normalizarNit`), así
 * cubre también los documentos viejos sin `emisor.nitNorm`. Mientras haya
 * `llavesDuplicadas > 0` en una empresa, el índice no se crea ahí: Mongoose lo
 * intenta al arrancar y el fallo queda como warn de `TenantModelRegistry` (sin
 * datos). Si `sinNitNorm > 0`, corre antes `2026-10-nit-norm-electronic-documents.ts`.
 *
 *   pnpm build
 *   node dist/datos/2026-10-consecutivo-duplicado-informe.js --empresa <id>
 *   node dist/datos/2026-10-consecutivo-duplicado-informe.js --todas
 */

void enCadaEmpresa({
  nombre: 'informe de consecutivos duplicados que impiden el índice único de electronic_documents',
  contar: async (app) => {
    const docs = app.get<Model<ElectronicDocumentDocument>>(getModelToken(ElectronicDocument.name));
    const grupos = await docs
      .aggregate<GrupoConsecutivoDuplicado>(PIPELINE_CONSECUTIVO_DUPLICADO)
      .exec();
    for (const g of grupos) {
      console.log(
        `  NIT ${g._id.nit} prefijo ${g._id.prefix ?? '(ninguno)'} número ${g._id.number}: ${g.n} documentos (${g.documentos.join(', ')})`,
      );
    }
    const indices = (await docs.collection.indexes()).map((i) => String(i.name));
    const sinNitNorm = await docs.countDocuments(FILTRO_SIN_NIT_NORM).exec();
    return contarConsecutivosDuplicados(grupos, indices, sinNitNorm);
  },
  aplicar: () =>
    Promise.reject(
      new Error('Solo informe: un consecutivo duplicado se resuelve a mano, no por script.'),
    ),
});
