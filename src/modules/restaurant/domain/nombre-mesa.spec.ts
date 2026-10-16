import { describe, it, expect } from 'vitest';
import { nombreDeMesa } from './nombre-mesa';

describe('nombreDeMesa', () => {
  it('no repite "Mesa" cuando la mesa ya se llama así', () => {
    expect(nombreDeMesa('Mesa 5')).toBe('Mesa 5');
    expect(nombreDeMesa('mesa vip')).toBe('mesa vip');
  });

  it('antepone "Mesa" a los nombres que no lo traen', () => {
    expect(nombreDeMesa('5')).toBe('Mesa 5');
    expect(nombreDeMesa('Terraza 2')).toBe('Mesa Terraza 2');
    expect(nombreDeMesa('Mesanine')).toBe('Mesa Mesanine');
  });
});
