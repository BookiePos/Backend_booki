import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  COMPLETAR_NULOS,
  FILTRO_FUERA_DEL_INDICE,
  INDICE_ORIGEN_VIEJO,
  PIPELINE_ORIGEN_DUPLICADO,
  PIPELINE_REVERSA_DUPLICADA,
  contarDuplicados,
  planIndices,
  type GrupoDuplicado,
} from './duplicados-libro';
import {
  JournalEntry,
  type JournalEntryDocument,
} from '../modules/core-ledger/infrastructure/schemas/journal-entry.schema';

/**
 * Por qué existe (checklist 1.13): deja creados los índices únicos del libro
 * en las empresas donde Mongoose no pudo crearlos al arrancar (el log dice
 * «CONCILIAR: no se crearon los índices del libro»). Antes completa con null
 * `reversalOf`/`reversedBy` en los asientos viejos que no los tienen (si no,
 * el filtro parcial los deja fuera y no los protege). Si el índice viejo no
 * único `sourceType_1_sourceId_1` estorba, lo borra. Con asientos
 * duplicados NO hace nada: primero se corrigen con contra-asientos (ver
 * `2026-10-duplicados-libro-informe.ts`). Idempotente: con los índices ya
 * creados no toca nada.
 *
 *   pnpm build
 *   node dist/datos/2026-10-indices-libro.js --empresa <id>
 *   node dist/datos/2026-10-indices-libro.js --empresa <id> --aplicar
 *   node dist/datos/2026-10-indices-libro.js --todas
 *   node dist/datos/2026-10-indices-libro.js --todas --aplicar
 */

const modelo = (app: INestApplicationContext) =>
  app.get<Model<JournalEntryDocument>>(getModelToken(JournalEntry.name));

async function estado(app: INestApplicationContext) {
  const entries = modelo(app);
  const origen = await entries.aggregate<GrupoDuplicado>(PIPELINE_ORIGEN_DUPLICADO).exec();
  const reversas = await entries.aggregate<GrupoDuplicado>(PIPELINE_REVERSA_DUPLICADA).exec();
  const fuera = await entries.countDocuments(FILTRO_FUERA_DEL_INDICE).exec();
  const indices = (await entries.collection.indexes()).map((i) => String(i.name));
  return { conteo: contarDuplicados(origen, reversas, fuera, indices), indices };
}

void enCadaEmpresa({
  nombre: 'crear los índices únicos del libro donde faltan',
  contar: async (app) => {
    const { conteo, indices } = await estado(app);
    return { ...conteo, indiceViejo: indices.includes(INDICE_ORIGEN_VIEJO) ? 1 : 0 };
  },
  aplicar: async (app) => {
    const { conteo, indices } = await estado(app);
    const plan = planIndices(conteo, indices);
    if (plan.accion === 'nada') return;
    if (plan.accion === 'bloqueado') throw new Error(plan.motivo);
    const entries = modelo(app);
    if (plan.completarNulos) {
      for (const { filter, update } of COMPLETAR_NULOS) {
        await entries.collection.updateMany(filter, update);
      }
    }
    if (plan.borrarViejo) await entries.collection.dropIndex(INDICE_ORIGEN_VIEJO);
    if (plan.crearIndices) await entries.createIndexes();
  },
});
