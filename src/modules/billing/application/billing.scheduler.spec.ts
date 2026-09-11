import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas (aquí llegan por la cadena
// de imports del servicio de facturación). Mismo patrón que el resto.
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

import { BillingScheduler } from './billing.scheduler';

/**
 * Disparador del ciclo de cobro.
 *
 * Es el único que hace correr la facturación en producción: si no arranca, no
 * se cobra ninguna renovación y nadie se entera hasta que falta la plata del
 * mes. Y si se solapa consigo mismo, dos barridos a la vez cobran dos veces al
 * mismo cliente.
 *
 * También espera un rato antes del primer barrido: al arrancar, la conexión a
 * la base todavía no está lista, y cobrar sobre una conexión a medias es peor
 * que esperar un minuto.
 *
 * Se usan temporizadores simulados: ninguna prueba espera de verdad.
 */
describe('BillingScheduler', () => {
  const SEIS_HORAS = 6 * 60 * 60 * 1000;
  const ARRANQUE = 90 * 1000;

  let billing: any;
  let scheduler: BillingScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    billing = {
      runBillingCycle: vi
        .fn()
        .mockResolvedValue({ charged: 0, suspended: 0 }),
    };
    scheduler = new BillingScheduler(billing as never);
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    vi.useRealTimers();
  });

  it('no cobra nada en el instante del arranque', () => {
    scheduler.onModuleInit();

    expect(billing.runBillingCycle).not.toHaveBeenCalled();
  });

  it('hace el primer barrido tras la espera inicial', async () => {
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(ARRANQUE);

    expect(billing.runBillingCycle).toHaveBeenCalledOnce();
  });

  it('después repite cada seis horas', async () => {
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(ARRANQUE);
    await vi.advanceTimersByTimeAsync(SEIS_HORAS * 3);

    expect(billing.runBillingCycle).toHaveBeenCalledTimes(4);
  });

  it('no se solapa consigo mismo si un barrido se alarga', async () => {
    // Un barrido lento no puede permitir que entre el siguiente: dos a la vez
    // cobrarían dos veces la misma renovación.
    let resolver: (v: unknown) => void = () => undefined;
    billing.runBillingCycle.mockImplementation(
      () => new Promise((r) => (resolver = r)),
    );
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(ARRANQUE);
    await vi.advanceTimersByTimeAsync(SEIS_HORAS * 2);

    expect(billing.runBillingCycle).toHaveBeenCalledOnce();

    resolver({ charged: 0, suspended: 0 });
    await vi.advanceTimersByTimeAsync(SEIS_HORAS);
    expect(billing.runBillingCycle).toHaveBeenCalledTimes(2);
  });

  it('un barrido que falla no mata el programador', async () => {
    billing.runBillingCycle.mockRejectedValue(new Error('pasarela caída'));
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(ARRANQUE);
    await vi.advanceTimersByTimeAsync(SEIS_HORAS);

    expect(billing.runBillingCycle).toHaveBeenCalledTimes(2);
  });

  it('al apagar el servicio deja de cobrar', async () => {
    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(ARRANQUE);

    scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(SEIS_HORAS * 5);

    expect(billing.runBillingCycle).toHaveBeenCalledOnce();
  });

  it('apagar antes del primer barrido lo cancela', async () => {
    scheduler.onModuleInit();

    scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(ARRANQUE * 10);

    expect(billing.runBillingCycle).not.toHaveBeenCalled();
  });

  it('el temporizador no impide que el proceso termine', () => {
    // Sin `unref`, un contenedor no podría apagarse limpiamente: se quedaría
    // esperando el siguiente barrido.
    const unref = vi.fn();
    const original = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((...args: unknown[]) => {
      const t = (original as never as (...a: unknown[]) => any)(...args);
      return Object.assign(t, { unref });
    }) as never);

    scheduler.onModuleInit();

    expect(unref).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
