/**
 * Contador por ventana fija guardado en Mongo (ítem 4.3).
 *
 * En Vercel cada instancia de la función tiene su propia memoria: un contador
 * en memoria deja pasar N intentos POR INSTANCIA, y bajo carga hay muchas.
 * Guardado en la base de control, el contador es uno solo para todas.
 *
 * Es atómico sin transacciones: el primer paso suma en la ventana vigente; si
 * no hay ventana vigente, el segundo la abre con 1. Si dos instancias abren la
 * misma ventana a la vez, una choca con la llave duplicada y vuelve al primer
 * paso. Los documentos vencidos los borra el índice TTL sobre `hasta`.
 */

export interface DocVentana {
  _id: string;
  hits: number;
  hasta: Date;
}

/** Lo mínimo de una colección del driver de Mongo que usa el contador. */
export interface ColeccionVentanas {
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean; returnDocument: 'after' },
  ): Promise<DocVentana | null>;
  createIndex(
    spec: Record<string, 1>,
    options: { expireAfterSeconds: number },
  ): Promise<unknown>;
}

const LLAVE_DUPLICADA = 11000;

/** Suma uno en la ventana vigente de `id` (o abre una de `ttlMs`). */
export async function contarEnVentana(
  col: ColeccionVentanas,
  id: string,
  ttlMs: number,
  ahora = Date.now(),
): Promise<DocVentana> {
  const vigente = () =>
    col.findOneAndUpdate(
      { _id: id, hasta: { $gt: new Date(ahora) } },
      { $inc: { hits: 1 } },
      { returnDocument: 'after' },
    );
  const sumada = await vigente();
  if (sumada) return sumada;
  try {
    const abierta = await col.findOneAndUpdate(
      {
        _id: id,
        $or: [{ hasta: { $lte: new Date(ahora) } }, { hasta: { $exists: false } }],
      },
      { $set: { hits: 1, hasta: new Date(ahora + ttlMs) } },
      { upsert: true, returnDocument: 'after' },
    );
    if (abierta) return abierta;
  } catch (err) {
    if ((err as { code?: number }).code !== LLAVE_DUPLICADA) throw err;
  }
  // Otra instancia abrió la ventana entre los dos pasos: se suma en la suya.
  const otra = await vigente();
  if (!otra) throw new Error(`No se pudo contar en la ventana de ${id}`);
  return otra;
}

/** Crea el índice TTL una vez por colección y proceso. */
export function asegurarIndiceTtl(
  col: ColeccionVentanas,
  cache: WeakMap<object, Promise<unknown>>,
): Promise<unknown> {
  let p = cache.get(col);
  if (!p) {
    p = col.createIndex({ hasta: 1 }, { expireAfterSeconds: 0 }).catch((err: unknown) => {
      cache.delete(col);
      throw err;
    });
    cache.set(col, p);
  }
  return p;
}
