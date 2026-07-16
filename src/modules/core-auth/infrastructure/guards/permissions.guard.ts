import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { Permission } from '../../domain/permissions';
import { JwtUser } from '../jwt.strategy';

/**
 * Verifica los permisos exigidos por @RequirePermissions(). Corre después del
 * JwtAuthGuard, por lo que `request.user` ya está resuelto.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
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
