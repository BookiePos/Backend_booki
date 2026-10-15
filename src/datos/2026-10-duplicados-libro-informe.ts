import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  FILTRO_FUERA_DEL_INDICE,
  PIPELINE_ORIGEN_DUPLICADO,
  PIPELINE_REVERSA_DUPLICADA,
  contarDuplicados,
  type GrupoDuplicado,
} from './duplicados-libro';
import {
  JournalEntry,
  type JournalEntryDocument,
} from '../modules/core-ledger/infrastructure/schemas/journal-entry.schema';

/**
 * Por qué existe (checklist 1.13): antes de que los índices únicos del libro
 * queden creados en producción, lista los duplicados que lo impedirían y dice
 * si cada índice ya existe. SOLO LEE: `--aplicar` falla a propósito. Un
 * duplicado se corrige reversando el asiento sobrante (POST
 * /ledger/entries/:id/reverse), nunca borrándolo. Ver `duplicados-libro.ts`.
 *
 * Si `indiceOrigenCreado=0` o `indiceReversaCreado=0` sin duplicados, los
 * crea `2026-10-indices-libro.ts` (borra antes el índice viejo no único
 * `sourceType_1_sourceId_1` si estorba).
 *
 *   pnpm build
 *   node dist/datos/2026-10-duplicados-libro-informe.js --empresa <id>
 *   node dist/datos/2026-10-duplicados-libro-informe.js --todas
 */

void enCadaEmpresa({
  nombre: 'informe de asientos duplicados que impiden los índices únicos del libro',
  contar: async (app) => {
    const entries = app.get<Model<JournalEntryDocument>>(getModelToken(JournalEntry.name));
    const origen = await entries.aggregate<GrupoDuplicado>(PIPELINE_ORIGEN_DUPLICADO).exec();
    const reversas = await entries.aggregate<GrupoDuplicado>(PIPELINE_REVERSA_DUPLICADA).exec();
    for (const g of origen) {
      console.log(`  origen ${JSON.stringify(g._id)}: ${g.n} asientos vivos (${g.numeros.join(', ')})`);
    }
    for (const g of reversas) {
      console.log(`  asiento ${String(g._id)}: ${g.n} contra-asientos (${g.numeros.join(', ')})`);
    }
    const fuera = await entries.countDocuments(FILTRO_FUERA_DEL_INDICE).exec();
    const indices = (await entries.collection.indexes()).map((i) => String(i.name));
    return contarDuplicados(origen, reversas, fuera, indices);
  },
  aplicar: () =>
    Promise.reject(
      new Error('Solo informe: un asiento duplicado se corrige con un contra-asiento, no por script.'),
    ),
});
