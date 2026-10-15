import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Tracker del @Throttle de los endpoints que llaman a IA: cuenta por negocio,
 * no por IP, porque el costo es del negocio y varias sedes pueden compartir
 * IP (o un mismo negocio rotar de IP). El TenantMiddleware corre antes que los
 * guards, así que el contexto ya está abierto. Sin negocio cae a la IP.
 */
export function businessTracker(req: Record<string, unknown>): string {
  const businessId = TenantContext.current()?.businessId;
  return businessId ? `biz:${businessId}` : `ip:${String(req.ip)}`;
}

/** Límite propio de los endpoints con IA: 10 por minuto y negocio. */
export const AI_THROTTLE = {
  default: { limit: 10, ttl: 60_000, getTracker: businessTracker },
};
