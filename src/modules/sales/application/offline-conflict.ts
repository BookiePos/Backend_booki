import { ConflictException } from '@nestjs/common';
import {
  OFFLINE_CONFLICT_CODE,
  OfflineConflictReason,
} from '../domain/offline-sales';

/**
 * 409 de una venta offline que no se pudo registrar al sincronizar, con el
 * motivo legible por el terminal (`reason`) y por la persona (`message`). El
 * terminal la deja en la bandeja de conflictos; nunca la descarta solo.
 */
export function offlineConflict(
  reason: OfflineConflictReason,
  message: string,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: OFFLINE_CONFLICT_CODE,
    reason,
    message,
  });
}

/** ¿Este error es un conflicto offline ya clasificado? */
export function isOfflineConflict(err: unknown): err is ConflictException {
  if (!(err instanceof ConflictException)) return false;
  const body = err.getResponse() as { code?: string };
  return body?.code === OFFLINE_CONFLICT_CODE;
}
