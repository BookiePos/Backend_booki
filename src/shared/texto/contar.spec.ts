import { describe, expect, it } from 'vitest';
import { contar } from './contar';

describe('contar', () => {
  it('concuerda el número con la frase', () => {
    expect(contar(1, 'cuenta abierta', 'cuentas abiertas')).toBe('1 cuenta abierta');
    expect(contar(3, 'cuenta abierta', 'cuentas abiertas')).toBe('3 cuentas abiertas');
    expect(contar(2, 'día')).toBe('2 días');
    expect(contar(1500, 'número')).toBe('1.500 números');
  });
});
