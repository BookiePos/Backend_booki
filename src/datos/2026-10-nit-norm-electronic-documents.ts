import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  EXPR_NIT_NORM,
  FILTRO_SIN_NIT_NORM,
} from '../modules/einvoicing/domain/consecutivo-unico';
import {
  ElectronicDocument,
  type ElectronicDocumentDocument,
} from '../modules/einvoicing/infrastructure/schemas/electronic-document.schema';

/**
 * Por qué existe (checklist 1, Fase 1): el índice único `consecutivo_unico` va
 * sobre `emisor.nitNorm` (NIT base sin DV, solo dígitos). Los documentos
 * emitidos antes no lo tienen y quedarían fuera del índice; este script lo
 * calcula desde `emisor.nit` con la misma regla que `normalizarNit`. Solo toca
 * `emisor.nitNorm`: no cambia números, montos ni el NIT original.
 *
 * Idempotente: el filtro excluye los que ya lo tienen (si el NIT no trae
 * dígitos se guarda null, que también cuenta como ya procesado).
 *
 * Orden: 1) este script, 2) el informe de duplicados
 * (`2026-10-consecutivo-duplicado-informe.ts`), 3) desplegar.
 *
 *   pnpm build
 *   node dist/datos/2026-10-nit-norm-electronic-documents.js --empresa <id>
 *   node dist/datos/2026-10-nit-norm-electronic-documents.js --empresa <id> --aplicar
 *   node dist/datos/2026-10-nit-norm-electronic-documents.js --todas
 *   node dist/datos/2026-10-nit-norm-electronic-documents.js --todas --aplicar
 */

const modelo = (app: Parameters<Parameters<typeof enCadaEmpresa>[0]['contar']>[0]) =>
  app.get<Model<ElectronicDocumentDocument>>(getModelToken(ElectronicDocument.name));

void enCadaEmpresa({
  nombre: 'rellenar emisor.nitNorm en los documentos electrónicos existentes',
  contar: async (app) => ({
    sinNitNorm: await modelo(app).countDocuments(FILTRO_SIN_NIT_NORM).exec(),
  }),
  aplicar: async (app) => {
    await modelo(app).collection.updateMany({ ...FILTRO_SIN_NIT_NORM }, [
      { $set: { 'emisor.nitNorm': EXPR_NIT_NORM } },
    ]);
  },
});
