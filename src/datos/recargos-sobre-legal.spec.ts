import { describe, it, expect } from 'vitest';
import {
  contarExcesos,
  excesosExpediente,
  excesosParametros,
  revisarAMano,
} from './recargos-sobre-legal';
import { DEFAULT_PAYROLL_SETTINGS } from '../modules/payroll/domain/payroll.constants';

/**
 * Revisión 1.18 (H3): nómina ya no lee el dominical ni los combinados del
 * expediente, ni las vigencias de Parámetros sin autor (semillas). Si alguna
 * empresa tenía ahí un valor MAYOR que el legal de `recargosVigentes`, pudo
 * creer que lo pactó: se lista para revisarla a mano.
 */
const R = DEFAULT_PAYROLL_SETTINGS.recargos;

describe('excesosExpediente', () => {
  it('el expediente por defecto no excede el legal de octubre de 2026', () => {
    expect(excesosExpediente(R, '2026-10-14')).toEqual([]);
  });

  it('el 90 % guardado excede el 80 % legal de marzo de 2026, con sus combinados', () => {
    const campos = excesosExpediente(R, '2026-03-31').map((e) => e.campo);
    expect(campos).toEqual([
      'dominical',
      'nocturnoDominical',
      'extraDiurnaDominical',
      'extraNocturnaDominical',
    ]);
  });

  it('un dominical de 100 % en octubre de 2026 se lista', () => {
    const e = excesosExpediente({ ...R, dominical: 1 }, '2026-10-14');
    expect(e).toEqual([
      { origen: 'expediente', campo: 'dominical', valor: 1, legal: 0.9, desde: '2026-10-14' },
    ]);
  });
});

describe('excesosParametros', () => {
  it('lista la semilla sin autor de 90 % desde el 1-ene-2026 (legal 80 %)', () => {
    const e = excesosParametros([
      { key: 'recargo.dominical_festivo', value: 90, effectiveFrom: '2026-01-01' },
    ]);
    expect(e).toEqual([
      {
        origen: 'parametros',
        campo: 'recargo.dominical_festivo',
        valor: 0.9,
        legal: 0.8,
        desde: '2026-01-01',
      },
    ]);
  });

  it('ignora las vigencias con autor (son pactos) y las que no exceden', () => {
    expect(
      excesosParametros([
        { key: 'recargo.dominical_festivo', value: 100, effectiveFrom: '2026-01-01', createdByEmail: 'a@b.co' },
        { key: 'recargo.nocturno', value: 35, effectiveFrom: '2026-01-01' },
        { key: 'propina.sugerida', value: 10, effectiveFrom: '2026-01-01' },
      ]),
    ).toEqual([]);
  });

  it('cuenta y se niega a aplicar', async () => {
    const c = contarExcesos(excesosExpediente(R, '2026-03-31'), []);
    expect(c).toEqual({ expediente: 4, parametros: 0, aRevisar: 1 });
    await expect(revisarAMano()).rejects.toThrow(/a mano/);
  });
});
