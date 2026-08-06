import { SetMetadata } from '@nestjs/common';

export const NO_PERMISSION_KEY = 'noPermissionRequired';

/**
 * Marca un endpoint como accesible por cualquier usuario autenticado, sin
 * exigir un permiso concreto (opt-out explícito del deny-by-default del
 * PermissionsGuard). Úsese solo en rutas que a propósito no requieren permiso
 * (p. ej. datos propios del usuario como `GET /auth/me` o `POST /auth/logout`).
 * Para rutas totalmente públicas (sin login) usa @Public() en su lugar.
 */
export const NoPermissionRequired = () => SetMetadata(NO_PERMISSION_KEY, true);
