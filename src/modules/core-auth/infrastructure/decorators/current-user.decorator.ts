import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { JwtUser } from '../jwt.strategy';

/** Inyecta el usuario autenticado (resuelto por JwtStrategy) en el handler. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtUser => {
    const request = ctx.switchToHttp().getRequest<Request & { user: JwtUser }>();
    return request.user;
  },
);
