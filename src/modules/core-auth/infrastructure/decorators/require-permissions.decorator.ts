import { SetMetadata } from '@nestjs/common';
import { Permission } from '../../domain/permissions';

export const PERMISSIONS_KEY = 'requiredPermissions';

/** Exige uno o más permisos para acceder a la ruta (los evalúa PermissionsGuard). */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
