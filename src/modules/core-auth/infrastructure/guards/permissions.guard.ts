import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { NO_PERMISSION_KEY } from '../decorators/no-permission-required.decorator';
import { Permission } from '../../domain/permissions';
import { JwtUser } from '../jwt.strategy';

/**
 * Verifica los permisos exigidos por @RequirePermissions(). Corre después del
 * JwtAuthGuard, por lo que `request.user` ya está resuelto.
 *
 * Política **deny-by-default**: si un handler no es @Public(), no declara
 * @RequirePermissions() y tampoco se marcó con @NoPermissionRequired(), se
 * rechaza con 403. Así, un endpoint nuevo sin decorar queda cerrado por
 * omisión (antes quedaba abierto: fail-open).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Las rutas públicas no pasan por aquí (el JwtAuthGuard ya las dejó pasar),
    // pero por robustez respetamos el mismo opt-out.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const noPermissionRequired = this.reflector.getAllAndOverride<boolean>(
      NO_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (noPermissionRequired) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Deny-by-default: sin @RequirePermissions ni opt-out explícito, se cierra.
    if (!required || required.length === 0) {
      throw new ForbiddenException(
        'Endpoint sin permiso declarado (cerrado por omisión)',
      );
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtUser }>();
    const granted = new Set(request.user?.permissions ?? []);
    const ok = required.every((permission) => granted.has(permission));
    if (!ok) {
      throw new ForbiddenException('No tiene permisos para esta acción');
    }
    return true;
  }
}
