import { describe, it, expect, vi, beforeEach } from 'vitest';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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

import { BillingService } from './billing.service';
import {
  MAX_CHARGE_RETRIES,
  RETRY_COOLDOWN_MS,
} from '../domain/billing.constants';

/**
 * Ciclo de cobro y mora (dunning): lo que corre solo, cada pocas horas, sin que
 * nadie lo mire.
 *
 * Los dos errores posibles son caros en direcciones opuestas. Cobrar de más:
 * si el barrido no adelantara la fecha del próximo cobro, cada pasada volvería
 * a cobrarle la mensualidad al mismo cliente. Suspender de más: si el reintento
 * no respetara la espera, un cliente con un rechazo puntual agotaría los tres
 * intentos el mismo día y se quedaría sin sistema.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (businesses, wompi, subs, payments).
 */
describe('BillingService.runBillingCycle · cobro y mora', () => {
  let businesses: any;
  let wompi: any;
  let subs: any;
  let payments: any;
  let service: BillingService;

  /** Suscripción de una empresa, en el estado que pida cada caso. */
  function suscripcion(over: Record<string, unknown> = {}) {
    return {
      _id: 'sub1',
      businessId: 'biz1',
      plan: 'control',
      billingCycle: 'monthly',
      status: 'active',
      amountInCents: 9_900_000,
      customerEmail: 'duena@negocio.com',
      paymentSourceId: 123,
      failedAttempts: 0,
      nextChargeAt: new Date(Date.now() - 86_400_000),
      lastChargeAttemptAt: undefined as Date | undefined,
      canceledAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  /**
   * @param vencidas  suscripciones activas con cobro vencido
   * @param enMora    suscripciones ya en mora
   * @param respuesta estado que devuelve la pasarela al intentar el cobro
   */
  function build(
    vencidas: any[],
    enMora: any[],
    respuesta = 'APPROVED',
    extra: { canceladas?: any[]; pendientes?: any[] } = {},
  ) {
    const canceladas = extra.canceladas ?? [];
    const pendientes = extra.pendientes ?? [];
    businesses = {
      updatePlan: vi.fn().mockResolvedValue(undefined),
      addDocCredits: vi.fn().mockResolvedValue(undefined),
    };
    wompi = {
      configured: true,
      verifyEvent: vi.fn().mockReturnValue(true),
      createTransaction: vi
        .fn()
        .mockResolvedValue({ id: 'tx-1', status: respuesta }),
      getTransaction: vi
        .fn()
        .mockResolvedValue({ id: 'tx-1', status: respuesta }),
    };
    subs = {
      // El servicio distingue los grupos por el estado del filtro: activas
      // vencidas, en mora, y canceladas a las que ya se les acabó lo pagado.
      find: vi.fn((filter: any) => ({
        exec: () => {
          if (filter.status === 'past_due') return Promise.resolve(enMora);
          if (filter.status === 'canceled') return Promise.resolve(canceladas);
          return Promise.resolve(vencidas);
        },
      })),
      findOne: vi.fn(() => ({
        exec: () => Promise.resolve([...vencidas, ...enMora][0] ?? null),
      })),
    };
    payments = {
      create: vi.fn((doc: any) =>
        Promise.resolve({
          ...doc,
          _id: 'pay1',
          applied: false,
          save: vi.fn().mockResolvedValue(undefined),
        }),
      ),
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
      // Cobros que quedaron pendientes y hay que consultar a la pasarela.
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({ exec: () => Promise.resolve(pendientes) }),
        }),
      })),
    };

    service = new BillingService(
      businesses as never,
      wompi as never,
      subs as never,
      payments as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sin pasarela configurada no intenta cobrar nada', async () => {
    build([suscripcion()], []);
    wompi.configured = false;

    const r = await service.runBillingCycle();

    expect(r).toMatchObject({ charged: 0, suspended: 0 });
    expect(wompi.createTransaction).not.toHaveBeenCalled();
  });

  it('cobra la renovación vencida por el monto de la suscripción', async () => {
    build([suscripcion()], []);

    const r = await service.runBillingCycle();

    expect(r.charged).toBe(1);
    expect(wompi.createTransaction).toHaveBeenCalledOnce();
    expect(wompi.createTransaction.mock.calls[0][0]).toMatchObject({
      amountInCents: 9_900_000,
      paymentSourceId: 123,
    });
  });

  it('adelanta el próximo cobro ANTES de llamar a la pasarela', async () => {
    // Es lo que impide el doble cobro: si la respuesta tarda y entra otro
    // barrido, esta suscripción ya no aparece como vencida.
    const sub = suscripcion();
    build([sub], []);

    await service.runBillingCycle();

    expect((sub.nextChargeAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(sub.lastChargeAttemptAt).toBeInstanceOf(Date);
  });

  it('cada cobro usa una referencia distinta', async () => {
    build([suscripcion({ businessId: 'biz1' }), suscripcion({ businessId: 'biz2' })], []);

    await service.runBillingCycle();

    const refs = payments.create.mock.calls.map((c: any[]) => c[0].reference);
    expect(new Set(refs).size).toBe(2);
  });

  it('un fallo cobrando a una empresa no detiene el cobro de las demás', async () => {
    build([suscripcion({ businessId: 'biz1' }), suscripcion({ businessId: 'biz2' })], []);
    wompi.createTransaction
      .mockRejectedValueOnce(new Error('pasarela caída'))
      .mockResolvedValue({ id: 'tx-2', status: 'APPROVED' });

    const r = await service.runBillingCycle();

    expect(r.charged).toBe(1);
    expect(wompi.createTransaction).toHaveBeenCalledTimes(2);
  });

  describe('reintentos', () => {
    it('no reintenta antes de que pase la espera entre intentos', async () => {
      const enMora = suscripcion({
        status: 'past_due',
        failedAttempts: 1,
        lastChargeAttemptAt: new Date(Date.now() - RETRY_COOLDOWN_MS / 2),
      });
      build([], [enMora]);

      const r = await service.runBillingCycle();

      expect(wompi.createTransaction).not.toHaveBeenCalled();
      expect(r).toMatchObject({ charged: 0, suspended: 0 });
    });

    it('reintenta cuando ya pasó la espera', async () => {
      const enMora = suscripcion({
        status: 'past_due',
        failedAttempts: 1,
        lastChargeAttemptAt: new Date(Date.now() - RETRY_COOLDOWN_MS - 1_000),
      });
      build([], [enMora]);

      const r = await service.runBillingCycle();

      expect(wompi.createTransaction).toHaveBeenCalledOnce();
      expect(r.charged).toBe(1);
    });

    it('un reintento que vuelve a fallar no regala un mes de servicio', async () => {
      // El adelanto optimista de la fecha solo aplica a las suscripciones
      // activas. Si también corriera en mora, cada rechazo empujaría el cobro
      // un mes más y el cliente moroso seguiría usando el sistema gratis.
      const proximo = new Date(Date.now() - 86_400_000);
      const enMora = suscripcion({
        status: 'past_due',
        failedAttempts: 1,
        nextChargeAt: proximo,
        lastChargeAttemptAt: new Date(Date.now() - RETRY_COOLDOWN_MS - 1_000),
      });
      build([], [enMora], 'DECLINED');

      await service.runBillingCycle();

      expect(enMora.nextChargeAt).toBe(proximo);
      expect(enMora.status).toBe('past_due');
      expect(enMora.failedAttempts).toBe(2);
    });

    it('un reintento exitoso sí abre el período siguiente', async () => {
      const enMora = suscripcion({
        status: 'past_due',
        failedAttempts: 2,
        lastChargeAttemptAt: new Date(Date.now() - RETRY_COOLDOWN_MS - 1_000),
      });
      build([], [enMora]);

      await service.runBillingCycle();

      expect(enMora.status).toBe('active');
      expect(enMora.failedAttempts).toBe(0);
      expect((enMora.nextChargeAt as Date).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('suspensión', () => {
    it('suspende la empresa tras agotar los intentos', async () => {
      const enMora = suscripcion({
        status: 'past_due',
        failedAttempts: MAX_CHARGE_RETRIES,
      });
      build([], [enMora]);

      const r = await service.runBillingCycle();

      expect(r.suspended).toBe(1);
      expect(enMora.status).toBe('canceled');
      expect(enMora.canceledAt).toBeInstanceOf(Date);
      expect(businesses.updatePlan).toHaveBeenCalledWith('biz1', {
        status: 'suspended',
      });
    });

    it('no suspende ni cobra una vez agotados los intentos: solo suspende', async () => {
      const enMora = suscripcion({
        status: 'past_due',
        failedAttempts: MAX_CHARGE_RETRIES,
      });
      build([], [enMora]);

      await service.runBillingCycle();

      expect(wompi.createTransaction).not.toHaveBeenCalled();
    });

    it('con un intento menos del tope todavía no suspende', async () => {
      const enMora = suscripcion({
        status: 'past_due',
        failedAttempts: MAX_CHARGE_RETRIES - 1,
        lastChargeAttemptAt: new Date(Date.now() - RETRY_COOLDOWN_MS - 1_000),
      });
      build([], [enMora]);

      const r = await service.runBillingCycle();

      expect(r.suspended).toBe(0);
      expect(businesses.updatePlan).not.toHaveBeenCalledWith('biz1', {
        status: 'suspended',
      });
    });
  });

  it('sin nada vencido ni en mora, el barrido no hace nada', async () => {
    build([], []);

    const r = await service.runBillingCycle();

    expect(r).toMatchObject({ charged: 0, suspended: 0 });
    expect(payments.create).not.toHaveBeenCalled();
  });
});
