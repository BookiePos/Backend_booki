import { describe, it, expect } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

/**
 * Ítem 3.7: el Bearer solo acepta access tokens.
 *
 * La separación de secretos ya impide que un refresh pase la firma, pero el
 * claim `typ` lo hace explícito y no depende de que alguien configure bien el
 * entorno. Un token sin `typ` (emitido antes de este cambio) también se
 * rechaza: vive 15 minutos y el frontend, al recibir el 401, refresca solo.
 */
describe('JwtStrategy · solo access tokens', () => {
  const config = {
    get: (k: string) => (k === 'JWT_SECRET' ? 'acceso' : 'refresco'),
  } as unknown as ConfigService;
  const strategy = new JwtStrategy(config);
  const base = {
    sub: 'u1',
    email: 'c@x.com',
    role: 'cashier',
    permissions: [],
    sedeIds: [],
    biz: 'b1',
    sid: 'j1',
  };

  it('acepta typ access', () => {
    expect(strategy.validate({ ...base, typ: 'access' }).userId).toBe('u1');
  });

  it('rechaza un refresh usado como Bearer', () => {
    expect(() => strategy.validate({ ...base, typ: 'refresh' } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token sin typ', () => {
    expect(() => strategy.validate(base as never)).toThrow(
      UnauthorizedException,
    );
  });
});
