import type { ColeccionVentanas, DocVentana } from './contador-ventana';

/**
 * Colección en memoria para las pruebas del contador. Entiende solo los
 * filtros que usa `contarEnVentana` y, como Mongo, choca con llave duplicada
 * al hacer upsert de un `_id` que ya existe pero no cumple el filtro.
 */
export function coleccionFalsa(): ColeccionVentanas & {
  docs: Map<string, DocVentana>;
  falla?: Error;
} {
  const docs = new Map<string, DocVentana>();
  const cumple = (doc: DocVentana | undefined, filter: Record<string, unknown>) => {
    if (!doc) return false;
    const hasta = filter.hasta as { $gt?: Date } | undefined;
    if (hasta?.$gt) return doc.hasta > hasta.$gt;
    const or = filter.$or as { hasta: { $lte?: Date; $exists?: boolean } }[] | undefined;
    if (or) return or.some((c) => (c.hasta.$lte ? doc.hasta <= c.hasta.$lte : !doc.hasta));
    return true;
  };
  const col = {
    docs,
    falla: undefined as Error | undefined,
    async findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: { upsert?: boolean },
    ) {
      if (col.falla) throw col.falla;
      const id = filter._id as string;
      const doc = docs.get(id);
      if (cumple(doc, filter)) {
        const inc = update.$inc as { hits: number } | undefined;
        if (inc) doc!.hits += inc.hits;
        const set = update.$set as Partial<DocVentana> | undefined;
        if (set) Object.assign(doc!, set);
        return { ...doc! };
      }
      if (!options.upsert) return null;
      if (doc) throw Object.assign(new Error('E11000'), { code: 11000 });
      const nuevo = { _id: id, ...(update.$set as Omit<DocVentana, '_id'>) };
      docs.set(id, nuevo);
      return { ...nuevo };
    },
    async createIndex() {
      return 'hasta_1';
    },
  };
  return col;
}
