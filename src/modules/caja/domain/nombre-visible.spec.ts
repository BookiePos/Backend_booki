import { describe, expect, it } from 'vitest';
import { nombreVisible } from './nombre-visible';

describe('nombreVisible', () => {
  it('usa el nombre de la persona', () => {
    expect(nombreVisible({ name: '  Camila Restrepo ', email: 'demo@sistemapos.local' })).toBe('Camila Restrepo');
  });

  it('sin nombre, la parte del correo antes de la arroba', () => {
    expect(nombreVisible({ email: 'caja2@tienda.co' })).toBe('caja2');
    expect(nombreVisible({ name: '   ', email: 'caja2@tienda.co' })).toBe('caja2');
  });
});
