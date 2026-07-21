import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS } from './permissions';
import { ROLES } from './roles';

/** Forma mínima del usuario para decidir alcance por sede (la cumple JwtUser). */
export interface SedeScopeUser {
  role: string;
  permissions: string[];
  sedeIds: string[];
}

/**
 * ¿Ve TODAS las sedes? Solo el Dueño o quien tenga el permiso `sede.view_all`.
 * El Administrador NO lo tiene por defecto (puede haber admins por sede).
 */
export function canViewAllSedes(user: SedeScopeUser): boolean {
  return (
    user.role === ROLES.OWNER ||
    user.permissions.includes(PERMISSIONS.SEDE_VIEW_ALL)
  );
}

/**
 * Lista de sedes a las que el usuario está limitado, o `null` si puede ver
 * todas (sin filtro). Útil para construir filtros `{ sedeId: { $in } }`.
 */
export function allowedSedeIds(user: SedeScopeUser): string[] | null {
  return canViewAllSedes(user) ? null : user.sedeIds;
}

/** ¿Puede acceder a esta sede concreta? */
export function hasSedeAccess(user: SedeScopeUser, sedeId: string): boolean {
  return canViewAllSedes(user) || user.sedeIds.includes(sedeId);
}

/** Lanza 403 si el usuario no puede acceder a la sede indicada. */
export function assertSedeAccess(user: SedeScopeUser, sedeId: string): void {
  if (!hasSedeAccess(user, sedeId)) {
    throw new ForbiddenException('No tienes acceso a esta sede');
  }
}
