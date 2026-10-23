import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { TenantModelRegistry } from '../shared/tenancy/tenant-model.registry';
import { createModelProxy } from '../shared/tenancy/model-proxy';
import { TenantContext, dbNameForBusiness } from '../shared/tenancy/tenant-context';
import { LedgerService } from '../modules/core-ledger/application/ledger.service';
import { LedgerConciliacionService } from '../modules/core-ledger/application/ledger-conciliacion.service';
import { LedgerPostingService } from '../modules/core-ledger/application/ledger-posting.service';
import {
  JournalEntry,
  JournalEntrySchema,
} from '../modules/core-ledger/infrastructure/schemas/journal-entry.schema';
import {
  LedgerAccount,
  LedgerAccountSchema,
} from '../modules/core-ledger/infrastructure/schemas/ledger-account.schema';
import {
  LedgerPendiente,
  LedgerPendienteSchema,
} from '../modules/core-ledger/infrastructure/schemas/ledger-pendiente.schema';
import { Counter, CounterSchema } from '../modules/sales/infrastructure/schemas/counter.schema';

/**
 * Mongo real para las pruebas de integración (ítem 5.8): un mongod en memoria
 * standalone (igual que producción) y los servicios REALES del libro cableados
 * con el mismo TenantModelRegistry y proxy de modelo que usa Nest, sin mocks.
 */
export interface Entorno {
  root: Connection;
  ledger: LedgerService;
  posting: LedgerPostingService;
  conciliacion: LedgerConciliacionService;
  /** Corre `fn` dentro del contexto de la empresa `businessId`. */
  enEmpresa<T>(businessId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Proxy de modelo de empresa para un esquema más (como los de `@InjectModel`).
   * Se registra para que `enEmpresa` espere sus índices.
   */
  modelo<T = never>(name: string, schema: unknown): T;
  /** Base física `biz_<id>` de la empresa, sin pasar por el proxy. */
  baseDe(businessId: string): Connection;
  cerrar(): Promise<void>;
}

const ESQUEMAS: Array<[string, never]> = [
  [JournalEntry.name, JournalEntrySchema as never],
  [LedgerAccount.name, LedgerAccountSchema as never],
  [Counter.name, CounterSchema as never],
  [LedgerPendiente.name, LedgerPendienteSchema as never],
];

/** Arranca mongod en memoria con margen de sobra: el launchTimeout por defecto (10 s) falla en máquinas lentas. */
export function levantarMongod(): Promise<MongoMemoryServer> {
  return MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
}

export async function levantarEntorno(): Promise<Entorno> {
  const mongod = await levantarMongod();
  const root = await mongoose.createConnection(mongod.getUri()).asPromise();
  const registry = new TenantModelRegistry(root);

  const extra: Array<[string, never]> = [];
  const todos = () => [...ESQUEMAS, ...extra];
  const proxy = (name: string) => {
    const schema = ESQUEMAS.find(([n]) => n === name)![1];
    return createModelProxy(() => registry.modelFor(name, schema)) as never;
  };

  const ledger = new LedgerService(
    proxy(LedgerAccount.name),
    proxy(JournalEntry.name),
    proxy(Counter.name),
  );
  const conciliacion = new LedgerConciliacionService(proxy(LedgerPendiente.name));
  const posting = new LedgerPostingService(ledger, conciliacion);

  const enEmpresa = <T>(businessId: string, fn: () => Promise<T>): Promise<T> =>
    TenantContext.run({ businessId, dbName: dbNameForBusiness(businessId) }, async () => {
      // Los índices únicos se crean al compilar el modelo; se esperan para que
      // la prueba no corra antes de que existan.
      await Promise.all(todos().map(([n, s]) => registry.modelFor(n, s).init()));
      return fn();
    });

  return {
    root,
    ledger,
    posting,
    conciliacion,
    enEmpresa,
    modelo: <T,>(name: string, schema: unknown): T => {
      if (!todos().some(([n]) => n === name)) extra.push([name, schema as never]);
      const sch = todos().find(([n]) => n === name)![1];
      return createModelProxy(() => registry.modelFor(name, sch)) as T;
    },
    baseDe: (businessId) => root.useDb(dbNameForBusiness(businessId), { useCache: true }),
    cerrar: async () => {
      await root.close();
      await mongod.stop();
    },
  };
}
