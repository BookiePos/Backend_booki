import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { jwtSecret } from '../../../shared/config/jwt-secrets';
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
  /** Sesión: jti del refresh token con el que se emitió este access token. */
  sid?: string;
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
  sid?: string;
  /** Tipo de token (ítem 3.7): aquí solo vale `'access'`. */
  typ?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(config),
    });
  }

  validate(payload: AccessPayload): JwtUser {
    if (!payload?.sub) {
      throw new UnauthorizedException();
    }
    // Ítem 3.7: el Bearer solo acepta access tokens. Un token sin `typ` es de
    // antes de este cambio y se rechaza también: vive 15 minutos y el
    // frontend, ante el 401, refresca solo y recibe uno con `typ`. El coste
    // del despliegue es un refresh transparente, no un re-login.
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('Tipo de token inválido');
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
      sid: payload.sid,
    };
  }
}
