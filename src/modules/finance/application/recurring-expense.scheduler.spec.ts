import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo patrón que el resto de specs: los decoradores de @nestjs/mongoose
// revientan al importar esquemas (el scheduler arrastra servicios).
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { RecurringExpenseScheduler } from './recurring-expense.scheduler';

/**
 * Resultado del barrido de gastos recurrentes. `/cron/diario` lo convierte en
 * 200 o 500: si se tragara los fallos, el panel de Vercel Cron diría que todo
 * va bien mientras una empresa deja de generar sus gastos.
 */
describe('RecurringExpenseScheduler.sweep', () => {
  let businesses: any;
  let finance: any;
  let scheduler: RecurringExpenseScheduler;

  const empresa = (id: string) => ({ _id: id, dbName: `biz_${id}`, tipoNegocio: 'retail' });

  beforeEach(() => {
    businesses = { listActive: vi.fn().mockResolvedValue([empresa('a'), empresa('b')]) };
    finance = { runRecurring: vi.fn().mockResolvedValue({ generated: 1 }) };
    scheduler = new RecurringExpenseScheduler(businesses as never, finance as never);
  });

  it('todas las empresas bien: ok con las cifras', async () => {
    await expect(scheduler.sweep()).resolves.toEqual({
      estado: 'ok',
      cifras: { empresas: 2, procesadas: 2, pendientes: 0, generados: 2, fallidas: 0 },
    });
  });

  it('sin tiempo para empezar: las empresas quedan pendientes y el cron lo ve (ítem 2.10)', async () => {
    const r = await scheduler.sweep({ hasta: Date.now() - 1 });

    expect(finance.runRecurring).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      estado: 'error',
      detalle: '2 empresa(s) sin procesar por tiempo',
      cifras: { empresas: 2, procesadas: 0, pendientes: 2 },
    });
  });

  it('una empresa que falla no detiene las demás, pero el resultado es error', async () => {
    finance.runRecurring
      .mockRejectedValueOnce(new Error('base caída'))
      .mockResolvedValueOnce({ generated: 3 });

    const r = await scheduler.sweep();

    expect(finance.runRecurring).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({
      estado: 'error',
      cifras: { empresas: 2, generados: 3, fallidas: 1 },
    });
  });

  it('si ni siquiera puede listar las empresas devuelve error, no lanza', async () => {
    businesses.listActive.mockRejectedValue(new Error('control-plane caído'));

    await expect(scheduler.sweep()).resolves.toEqual({
      estado: 'error',
      detalle: 'control-plane caído',
    });
  });

  it('si ya hay un barrido en marcha devuelve omitido', async () => {
    let soltar: (v: unknown) => void = () => undefined;
    businesses.listActive.mockImplementation(() => new Promise((r) => (soltar = r)));
    const primero = scheduler.sweep();

    await expect(scheduler.sweep()).resolves.toMatchObject({ estado: 'omitido' });

    soltar([]);
    await expect(primero).resolves.toMatchObject({ estado: 'ok' });
  });
});
