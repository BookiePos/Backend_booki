import { describe, it, expect } from 'vitest';
import { ACC, SEED_ACCOUNTS } from './ledger.constants';

/**
 * Códigos del PUC comercial (Decreto 2650/93). El IVA y el INC generados no
 * van a la 2367/2368: esas son las retenciones de IVA (ReteIVA) y de ICA
 * (ReteICA) que el negocio practica como agente retenedor. Confundirlas
 * mezcla en una misma cuenta lo que se declara en formularios distintos.
 */
describe('Plan de cuentas · códigos PUC de impuestos', () => {
  const byCode = new Map(SEED_ACCOUNTS.map((a) => [a.code, a]));

  it('IVA por pagar es la 2408 y el INC por pagar la 2495', () => {
    expect(ACC.IVA_POR_PAGAR).toBe('2408');
    expect(ACC.INC_POR_PAGAR).toBe('2495');
    expect(byCode.get('2408')?.name).toMatch(/IVA/);
    expect(byCode.get('2495')?.name).toBe(
      'Impuesto nacional al consumo por pagar',
    );
  });

  it('conserva 2367 y 2368 con su nombre PUC real (ReteIVA, ReteICA)', () => {
    expect(byCode.get('2367')?.name).toMatch(/ReteIVA/);
    expect(byCode.get('2368')?.name).toMatch(/ReteICA/);
  });

  it('toda cuenta del posteo automático está sembrada', () => {
    for (const code of Object.values(ACC)) {
      expect(byCode.has(code), `falta sembrar la ${code}`).toBe(true);
    }
  });
});
