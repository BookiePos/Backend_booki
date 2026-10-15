import { describe, it, expect } from 'vitest';

import { sinLimitesParaE2e } from './sin-limites-e2e';

/** El interruptor de las pruebas e2e nunca apaga el rate limiting en producción. */
describe('sinLimitesParaE2e', () => {
  it('solo apaga los límites fuera de producción y con la variable explícita', () => {
    expect(sinLimitesParaE2e({ E2E_SIN_LIMITES: '1', NODE_ENV: 'development' })).toBe(true);
    expect(sinLimitesParaE2e({ E2E_SIN_LIMITES: '1', NODE_ENV: 'production' })).toBe(false);
    expect(sinLimitesParaE2e({ E2E_SIN_LIMITES: '1', VERCEL: '1' })).toBe(false);
    expect(sinLimitesParaE2e({ NODE_ENV: 'development' })).toBe(false);
  });
});
