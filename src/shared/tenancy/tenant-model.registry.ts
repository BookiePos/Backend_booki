import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Schema } from 'mongoose';
import { TenantContext } from './tenant-context';

/**
 * Resuelve conexiones y modelos apuntando a la base de datos de la empresa
 * activa. Una sola conexión raíz (pool) sirve todas las empresas vía
 * `useDb(dbName)`, que reutiliza el mismo cliente/pool de Mongo.
 *
 * `useCache: true` hace que `useDb` devuelva SIEMPRE el mismo objeto Connection
 * por base, así que el modelo compilado y las sesiones/transacciones son
 * consistentes entre sí.
 */
@Injectable()
export class TenantModelRegistry {
  private readonly logger = new Logger(TenantModelRegistry.name);

  constructor(
    // Conexión raíz por defecto (NO se sobrescribe su token, para evitar
    // recursión: este registry ES quien la usa para derivar las de tenant).
    @InjectConnection() private readonly root: Connection,
  ) {}

  /** Conexión a la base de la empresa activa (o a `dbName` explícito). */
  connectionFor(dbName?: string): Connection {
    const name = dbName ?? TenantContext.currentOrThrow().dbName;
    return this.root.useDb(name, { useCache: true });
  }

  /** Modelo compilado sobre la base de la empresa activa. */
  modelFor<T = unknown>(name: string, schema: Schema): Model<T> {
    const conn = this.connectionFor();
    // conn.models cachea por (conexión, nombre); evita OverwriteModelError.
    const cached = (conn.models as Record<string, Model<unknown>>)[name];
    if (cached) return cached as unknown as Model<T>;
    // Se castea `conn.model` a una firma simple: sus sobrecargas genéricas con
    // un `Schema` sin tipar hacen que el compilador instancie un tipo enorme
    // (OOM). El comportamiento en runtime es idéntico.
    const compile = conn.model as unknown as (
      n: string,
      s: Schema,
    ) => Model<unknown>;
    const model = compile.call(conn, name, schema);
    // Un índice único que Mongo no pudo crear (p. ej. hay duplicados) falla en
    // silencio: Mongoose solo emite 'index' con el error. Se deja un warn sin
    // datos (el mensaje de E11000 trae los valores) con el modelo y la llave.
    model.on('index', (err?: { code?: number; keyPattern?: Record<string, unknown> }) => {
      if (!err) return;
      this.logger.warn(
        `No se pudo crear un índice de ${name} (código ${err.code ?? '?'}, llave ${Object.keys(err.keyPattern ?? {}).join(',') || 'desconocida'}). Revisa si hay duplicados.`,
      );
    });
    return model as unknown as Model<T>;
  }
}
