import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { BusinessType } from '../../control/domain/control.constants';

/** Usuario resuelto desde el access token y adjuntado a `request.user`. */
export interface JwtUser {
  userId: string;
  email: string;
  name?: string;
  role: string;
  permissions: string[];
  sedeIds: string[];
  /** Empresa (tenant) del usuario. */
  businessId?: string;
  /** Giro del negocio (restaurante | retail). */
  tipoNegocio?: BusinessType;
}

interface AccessPayload {
  sub: string;
  email: string;
  name?: string;
  role: string;
  permissions: string[];
  sedeIds: string[];
  /** Empresa (tenant); el middleware lo usa para abrir el contexto de datos. */
  biz?: string;
  /** Giro del negocio (restaurante | retail). */
  biztype?: BusinessType;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'dev-secret',
    });
  }

  validate(payload: AccessPayload): JwtUser {
    if (!payload?.sub) {
      throw new UnauthorizedException();
    }
    return {
      userId: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      permissions: payload.permissions ?? [],
      sedeIds: payload.sedeIds ?? [],
      businessId: payload.biz,
      tipoNegocio: payload.biztype,
    };
  }
}
