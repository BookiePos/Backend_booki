import { SetMetadata } from '@nestjs/common';
import { Permission } from '../../domain/permissions';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSION_KEY = 'anyOfPermissions';

/** Exige uno o más permisos para acceder a la ruta (los evalúa PermissionsGuard). */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Basta con UNO de los permisos. Para lecturas que comparten dos roles con
 * tareas distintas: la cola de consumos la ve quien consulta la nómina y
 * también quien aprueba (el Gerente), que sin ella no tiene qué aprobar.
 */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(ANY_PERMISSION_KEY, permissions);
