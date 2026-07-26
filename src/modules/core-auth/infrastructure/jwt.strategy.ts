import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

/** Usuario resuelto desde el access token y adjuntado a `request.user`. */
export interface JwtUser {
  userId: string;
  email: string;
  name?: string;
  role: string;
  permissions: string[];
  sedeIds: string[];
}

interface AccessPayload {
  sub: string;
  email: string;
  name?: string;
  role: string;
  permissions: string[];
  sedeIds: string[];
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
    };
  }
}
