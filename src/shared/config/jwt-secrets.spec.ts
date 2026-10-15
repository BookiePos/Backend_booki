import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { jwtSecret, jwtRefreshSecret } from './jwt-secrets';

/** ConfigService falso: devuelve valores de un mapa. */
function fakeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('jwt-secrets (smoke del runner de tests)', () => {
  it('devuelve el JWT_SECRET cuando está definido', () => {
    const config = fakeConfig({ JWT_SECRET: 'super-secreto' });
    expect(jwtSecret(config)).toBe('super-secreto');
  });

  it('lanza si JWT_SECRET falta (no cae a un fallback inseguro)', () => {
    const config = fakeConfig({});
    expect(() => jwtSecret(config)).toThrow();
  });

  // Ítem 3.7: antes el refresh caía a JWT_SECRET. Con un solo secreto, un
  // access token pasaba la verificación del refresh (y viceversa) y
  // `findOne({jti: undefined})` podía devolver la sesión de otra persona.
  it('lanza si falta JWT_REFRESH_SECRET (ya no cae a JWT_SECRET)', () => {
    const config = fakeConfig({ JWT_SECRET: 'base' });
    expect(() => jwtRefreshSecret(config)).toThrow('JWT_REFRESH_SECRET');
  });

  it('lanza si JWT_REFRESH_SECRET es igual a JWT_SECRET', () => {
    const config = fakeConfig({ JWT_SECRET: 'base', JWT_REFRESH_SECRET: 'base' });
    expect(() => jwtRefreshSecret(config)).toThrow('JWT_REFRESH_SECRET');
  });

  it('devuelve JWT_REFRESH_SECRET cuando está y es distinto', () => {
    const config = fakeConfig({ JWT_SECRET: 'base', JWT_REFRESH_SECRET: 'otro' });
    expect(jwtRefreshSecret(config)).toBe('otro');
  });
});
