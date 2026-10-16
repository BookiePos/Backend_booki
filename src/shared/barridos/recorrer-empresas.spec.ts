import { describe, it, expect } from 'vitest';
import { recorrerEmpresas } from './recorrer-empresas';

/**
 * Ítem 2.10: el cron diario corre en una función con tope de tiempo. Recorrer
 * todas las empresas en serie lo dejaba a merced de ese tope: al crecer, se
 * cortaba a mitad sin que nadie lo notara.
 */
describe('recorrerEmpresas', () => {
  const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('procesa varias a la vez sin pasar del tope de concurrencia', async () => {
    let enCurso = 0;
    let maximo = 0;
    const r = await recorrerEmpresas([1, 2, 3, 4, 5, 6, 7], async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await espera(5);
      enCurso--;
    }, { concurrencia: 3, hasta: Date.now() + 10_000 });

    expect(r).toMatchObject({ procesadas: 7, pendientes: 0, fallidas: [] });
    expect(maximo).toBe(3);
  });

  it('deja de empezar empresas al acabarse el tiempo y las reporta pendientes', async () => {
    const r = await recorrerEmpresas([1, 2, 3, 4, 5], async () => {
      await espera(20);
    }, { concurrencia: 1, hasta: Date.now() + 30 });

    expect(r.procesadas).toBeGreaterThanOrEqual(1);
    expect(r.procesadas + r.pendientes).toBe(5);
    expect(r.pendientes).toBeGreaterThan(0);
  });

  it('un fallo no detiene a las demás y queda en la lista', async () => {
    const r = await recorrerEmpresas(['a', 'b', 'c'], async (x) => {
      if (x === 'b') throw new Error('boom');
    }, { concurrencia: 2, hasta: Date.now() + 10_000, clave: (x) => x });

    expect(r.procesadas).toBe(3);
    expect(r.fallidas).toEqual(['b']);
  });

  it('empieza por otra empresa según el desplazamiento, sin saltarse ninguna', async () => {
    const orden: number[] = [];
    await recorrerEmpresas([1, 2, 3, 4], async (x) => {
      orden.push(x);
    }, { concurrencia: 1, hasta: Date.now() + 10_000, desplazamiento: 2 });

    expect(orden).toEqual([3, 4, 1, 2]);
  });
});
