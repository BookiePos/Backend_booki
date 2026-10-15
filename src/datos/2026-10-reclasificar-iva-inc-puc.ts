import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  aplicarReclasificacion,
  contarReclasificacion,
  leerCorte,
  USO_CORTE,
  type DepsReclasificacion,
} from './reclasificacion-impuestos-puc';
import { LedgerService } from '../modules/core-ledger/application/ledger.service';
import {
  JournalEntry,
  type JournalEntryDocument,
} from '../modules/core-ledger/infrastructure/schemas/journal-entry.schema';
import {
  LedgerAccount,
  type LedgerAccountDocument,
} from '../modules/core-ledger/infrastructure/schemas/ledger-account.schema';
import type { INestApplicationContext } from '@nestjs/common';

/**
 * Por qué existe: el IVA y el INC se posteaban a la 2367/2368, que en el PUC son
 * ReteIVA y ReteICA. El código ya usa 2408/2495; esto traslada el saldo viejo
 * con un asiento de reclasificación a la fecha de corte (ver el módulo
 * `reclasificacion-impuestos-puc.ts` y docs/DATOS-PRODUCCION.md).
 *
 *   pnpm build
 *   node dist/datos/2026-10-reclasificar-iva-inc-puc.js --corte 2026-10-13 --empresa <id>
 *   node dist/datos/2026-10-reclasificar-iva-inc-puc.js --corte 2026-10-13 --empresa <id> --aplicar
 *   node dist/datos/2026-10-reclasificar-iva-inc-puc.js --corte 2026-10-13 --todas
 *   node dist/datos/2026-10-reclasificar-iva-inc-puc.js --corte 2026-10-13 --todas --aplicar
 */

const argv = process.argv.slice(2);
const corte = leerCorte(argv);
if (!corte) {
  console.error(USO_CORTE);
  process.exit(2);
}

function deps(app: INestApplicationContext): DepsReclasificacion {
  const ledger = app.get(LedgerService);
  return {
    entries: app.get<Model<JournalEntryDocument>>(getModelToken(JournalEntry.name)),
    accounts: app.get<Model<LedgerAccountDocument>>(getModelToken(LedgerAccount.name)),
    post: (input) => ledger.post(input),
  };
}

void enCadaEmpresa(
  {
    nombre: `reclasificar IVA 2367→2408 e INC 2368→2495 al ${corte}`,
    contar: (app) => contarReclasificacion(deps(app), corte),
    aplicar: (app) => aplicarReclasificacion(deps(app), corte),
  },
  argv,
);
