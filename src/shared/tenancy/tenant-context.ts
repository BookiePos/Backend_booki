import { AsyncLocalStorage } from 'node:async_hooks';
import type { BusinessType } from '../../modules/control/domain/control.constants';

/**
 * Contexto de empresa (tenant) activo durante una request.
 *
 * En el modelo multi-empresa cada negocio vive en su propia base de datos
 * (`biz_<businessId>`). Este contexto —propagado con AsyncLocalStorage— dice a
 * qué base apuntar. Lo establece el `TenantMiddleware` (desde el claim `biz` del
 * JWT) y, en los flujos pre-auth (login/registro/refresh/seed), lo abre a mano
 * el propio servicio con `TenantContext.run(...)`.
 */
export interface TenantContextData {
  businessId: string;
  dbName: string;
  /**
   * Giro del negocio (restaurante | retail). Viaja en el claim `biztype` del
   * access token; permite a los servicios del tenant (p. ej. catálogo) aplicar
   * reglas por tipo sin consultar el control-plane. Opcional: los tokens
   * emitidos antes de esta feature no lo traen.
   */
  tipoNegocio?: BusinessType;
}

const storage = new AsyncLocalStorage<TenantContextData>();

/** Nombre de la base de datos de una empresa. */
export function dbNameForBusiness(businessId: string): string {
  return `biz_${businessId}`;
}

export const TenantContext = {
  /** Corre `fn` con el contexto de empresa activo. */
  run<T>(ctx: TenantContextData, fn: () => T): T {
    return storage.run(ctx, fn);
  },

  /** Contexto activo, o `undefined` si la operación no tiene empresa (público). */
  current(): TenantContextData | undefined {
    return storage.getStore();
  },

  /** Contexto activo o error claro si falta (uso interno de la capa de datos). */
  currentOrThrow(): TenantContextData {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new Error(
        'No hay contexto de empresa (tenant) para esta operación de base de datos.',
      );
    }
    return ctx;
  },
};
