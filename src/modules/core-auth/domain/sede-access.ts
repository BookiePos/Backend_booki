import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

/**
 * Alcance de una consulta de lectura. Si pide una sede concreta la valida (403
 * si es ajena) y el alcance es solo esa; si no pide ninguna, el alcance son sus
 * sedes (`null` = ve todas, sin filtro). Un usuario sin sedes asignadas recibe
 * `[]`: no ve nada, en vez de ver la empresa entera.
 */
export function resolveSedeScope(
  user: SedeScopeUser,
  sedeId?: string,
): string[] | null {
  if (sedeId) {
    // Antes del 403: un id mal formado reventaba más abajo en `new ObjectId`.
    if (!esIdSedeValido(sedeId)) {
      throw new BadRequestException('sedeId inválido');
    }
    assertSedeAccess(user, sedeId);
    return [sedeId];
  }
  return allowedSedeIds(user);
}

/** ObjectId de Mongo: 24 hex. Sin importar Mongoose, que el dominio no lo toca. */
export function esIdSedeValido(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

/** Qué cubre una cifra: la empresa entera o solo unas sedes. */
export type AlcanceInforme =
  | { alcance: 'empresa' }
  | { alcance: 'sedes'; sedes: string[] };

/**
 * Marca de alcance para estados financieros y balances. Una cifra limitada a
 * sedes no es el estado oficial de la empresa (le faltan los renglones sin
 * sede) y la UI no debe presentarla como tal.
 */
export function alcanceDeSedes(sedes: string[] | null): AlcanceInforme {
  return sedes === null
    ? { alcance: 'empresa' }
    : { alcance: 'sedes', sedes: [...sedes] };
}
