import { Model } from 'mongoose';
import { TenantContext } from './tenant-context';

/**
 * Envuelve un `Model` de Mongoose en un Proxy que resuelve el modelo REAL en
 * cada acceso, sobre la base de datos de la empresa activa (ver
 * TenantModelRegistry). Así un único provider singleton (registrado bajo el
 * token que espera `@InjectModel`) sirve a todas las empresas.
 *
 * Clave: FUERA de un contexto de empresa el proxy es inerte. En el arranque /
 * inyección de dependencias no hay empresa activa, y NestJS sondea propiedades
 * como `.then` (para detectar promesas) sobre el valor inyectado; si
 * resolviéramos el modelo ahí, fallaría por falta de contexto. El modelo real
 * se resuelve solo en tiempo de request, cuando el middleware ya abrió el
 * contexto.
 *
 * El target es una función para poder atrapar `new Model()` (construcción de
 * documentos) además de los estáticos (`create`, `find`, `aggregate`, …).
 */
export function createModelProxy<T = unknown>(
  resolve: () => Model<T>,
): Model<T> {
  const handler: ProxyHandler<() => void> = {
    get(_target, prop) {
      if (TenantContext.current() === undefined) return undefined;
      const model = resolve() as unknown as Record<PropertyKey, unknown>;
      const value = model[prop];
      // Los estáticos deben conservar `this` = modelo real.
      return typeof value === 'function' ? value.bind(model) : value;
    },
    set(_target, prop, value) {
      if (TenantContext.current() === undefined) return true;
      const model = resolve() as unknown as Record<PropertyKey, unknown>;
      model[prop] = value;
      return true;
    },
    has(_target, prop) {
      if (TenantContext.current() === undefined) return false;
      return prop in (resolve() as unknown as object);
    },
    construct(_target, args) {
      const ModelCtor = resolve() as unknown as new (...a: unknown[]) => object;
      return new ModelCtor(...args);
    },
  };
  // El cast es seguro: el proxy delega todo acceso al Model real resuelto.
  return new Proxy(function () {}, handler) as unknown as Model<T>;
}
