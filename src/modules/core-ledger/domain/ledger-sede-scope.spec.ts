import { describe, it, expect, vi } from 'vitest';
import { balancePorSedes, lineasEnSedes } from './ledger-sede-scope';

describe('lineasEnSedes · bordes', () => {
  it('un asiento sin renglones no está en ningún alcance', () => {
    expect(lineasEnSedes([], ['a'])).toBe(false);
  });

  it('con sedeIds vacío ningún asiento entra', () => {
    expect(lineasEnSedes([{ sedeId: 'a' }], [])).toBe(false);
  });

  it('un renglón sin sede (nivel empresa) saca al asiento del alcance', () => {
    expect(lineasEnSedes([{ sedeId: 'a' }, {}], ['a'])).toBe(false);
    expect(lineasEnSedes([{ sedeId: 'a' }, { sedeId: 'b' }], ['a', 'b'])).toBe(true);
  });
});

describe('balancePorSedes · bordes', () => {
  const vacio = { rows: [], totalDebit: 0, totalCredit: 0, balanced: true };

  it('con [] devuelve un balance vacío y no consulta el ledger', async () => {
    const run = vi.fn();
    const r = await balancePorSedes(run, { from: '2026-01-01' }, []);
    expect(run).not.toHaveBeenCalled();
    expect(r).toEqual({ from: '2026-01-01', to: undefined, ...vacio });
  });

  it('con null pide sin filtro de sede', async () => {
    const run = vi.fn().mockResolvedValue(vacio);
    await balancePorSedes(run, { to: '2026-02-01' }, null);
    expect(run).toHaveBeenCalledWith({ to: '2026-02-01' });
  });
});
