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

  it('el refresh cae a JWT_SECRET si no hay JWT_REFRESH_SECRET', () => {
    const config = fakeConfig({ JWT_SECRET: 'base' });
    expect(jwtRefreshSecret(config)).toBe('base');
  });
});
