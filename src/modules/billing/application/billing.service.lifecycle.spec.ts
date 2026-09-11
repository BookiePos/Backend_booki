import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

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
import { PENDING_RECONCILE_AFTER_MS } from '../domain/billing.constants';

/**
 * Los cuatro agujeros del ciclo de vida del cobro, cerrados.
 *
 * Los cuatro compartían la misma forma: nada falla, nada se registra, y el
 * dinero simplemente deja de entrar o el servicio se regala.
 *
 *  1. Un webhook que se validaba contra un secreto vacío cuando la pasarela no
 *     estaba configurada, de modo que cualquiera podía activarse el plan.
 *  2. Un cobro que quedaba "pendiente" y no se resolvía nunca si el webhook se
 *     perdía: ni se activaba el plan pagado, ni se reintentaba.
 *  3. Cancelar, que dejaba a la empresa con su plan para siempre porque nadie
 *     volvía a mirar esa suscripción.
 *  4. El aniversario de cobro, que en los días 29, 30 y 31 se desbordaba al mes
 *     siguiente y regalaba un mes de servicio.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (businesses, wompi, subs, payments).
 */
describe('BillingService · ciclo de vida del cobro', () => {
  const BIZ = 'biz1';

  let businesses: any;
  let wompi: any;
  let subs: any;
  let payments: any;
  let service: BillingService;

  /** Suscripción de la empresa, en el estado que pida cada caso. */
  function suscripcion(over: Record<string, unknown> = {}) {
    return {
      _id: 'sub1',
      businessId: BIZ,
      plan: 'control',
      billingCycle: 'monthly',
      status: 'active',
      customerEmail: 'duena@negocio.com',
      paymentSourceId: 4321,
      amountInCents: 22_990_000,
      failedAttempts: 0,
      currentPeriodEnd: undefined as Date | undefined,
      nextChargeAt: undefined as Date | undefined,
      accessEndedAt: undefined as Date | undefined,
      canceledAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  /** Pago pendiente de resolución. */
  function pagoPendiente(over: Record<string, unknown> = {}) {
    return {
      _id: 'pay1',
      businessId: BIZ,
      kind: 'renewal',
      plan: 'control',
      status: 'pending',
      applied: false,
      wompiTransactionId: 'tx-1',
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  function build(opts: {
    sub?: any;
    canceladas?: any[];
    pendientes?: any[];
    estadoConsulta?: string;
    configurada?: boolean;
  } = {}) {
    const sub = opts.sub ?? suscripcion();
    businesses = {
      updatePlan: vi.fn().mockResolvedValue(undefined),
      addDocCredits: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue({ ownerEmail: 'duena@negocio.com' }),
    };
    wompi = {
      configured: opts.configurada ?? true,
      verifyEvent: vi.fn().mockReturnValue(true),
      createTransaction: vi
        .fn()
        .mockResolvedValue({ id: 'tx-1', status: 'PENDING' }),
      getTransaction: vi
        .fn()
        .mockResolvedValue({ id: 'tx-1', status: opts.estadoConsulta ?? 'APPROVED' }),
    };
    subs = {
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(sub) })),
      find: vi.fn((filter: any) => ({
        exec: () =>
          Promise.resolve(
            filter.status === 'canceled' ? (opts.canceladas ?? []) : [],
          ),
      })),
      findOneAndUpdate: vi.fn(),
    };
    payments = {
      create: vi.fn(),
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(pagoPendiente()) })),
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({ exec: () => Promise.resolve(opts.pendientes ?? []) }),
        }),
      })),
    };

    service = new BillingService(
      businesses as never,
      wompi as never,
      subs as never,
      payments as never,
    );
    return sub;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. webhook con la pasarela sin configurar', () => {
    it('se rechaza sin siquiera validar la firma', async () => {
      build({ configurada: false });

      await expect(
        service.handleWebhook({
          event: 'transaction.updated',
          data: { transaction: { id: 'tx', reference: 'r', status: 'APPROVED' } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Sin llaves, el secreto es la cadena vacía: validar la firma no protege
      // de nada, así que ni se intenta.
      expect(wompi.verifyEvent).not.toHaveBeenCalled();
      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('con la pasarela configurada sí se valida y se aplica', async () => {
      build();

      await service.handleWebhook({
        event: 'transaction.updated',
        data: { transaction: { id: 'tx', reference: 'r', status: 'APPROVED' } },
      });

      expect(wompi.verifyEvent).toHaveBeenCalledOnce();
      expect(businesses.updatePlan).toHaveBeenCalled();
    });
  });

  describe('2. cobros pendientes que nadie resolvía', () => {
    it('consulta a la pasarela por el pago pendiente y aplica el resultado', async () => {
      const pendiente = pagoPendiente();
      build({ pendientes: [pendiente] });

      const r = await service.runBillingCycle();

      expect(wompi.getTransaction).toHaveBeenCalledWith('tx-1');
      expect(r.reconciled).toBe(1);
      expect(pendiente.applied).toBe(true);
      expect(businesses.updatePlan).toHaveBeenCalled();
    });

    it('un pago que la pasarela también da por rechazado se marca rechazado', async () => {
      const pendiente = pagoPendiente();
      build({ pendientes: [pendiente], estadoConsulta: 'DECLINED' });

      const r = await service.runBillingCycle();

      expect(pendiente.status).toBe('declined');
      expect(r.reconciled).toBe(1);
      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('si sigue pendiente en la pasarela, se deja para el próximo barrido', async () => {
      const pendiente = pagoPendiente();
      build({ pendientes: [pendiente], estadoConsulta: 'PENDING' });

      const r = await service.runBillingCycle();

      expect(r.reconciled).toBe(0);
      expect(pendiente.applied).toBe(false);
    });

    it('solo mira los cobros con antigüedad: el webhook tiene su oportunidad', async () => {
      build({ pendientes: [] });

      await service.runBillingCycle();

      const filtro = payments.find.mock.calls[0][0];
      expect(filtro.status).toBe('pending');
      const corte = filtro.createdAt.$lte as Date;
      const esperado = Date.now() - PENDING_RECONCILE_AFTER_MS;
      expect(Math.abs(corte.getTime() - esperado)).toBeLessThan(5_000);
    });

    it('solo mira los que llegaron a tener transacción en la pasarela', async () => {
      build({ pendientes: [] });

      await service.runBillingCycle();

      expect(payments.find.mock.calls[0][0].wompiTransactionId).toEqual({
        $ne: null,
      });
    });

    it('un fallo consultando uno no detiene la reconciliación de los demás', async () => {
      const a = pagoPendiente({ _id: 'a', wompiTransactionId: 'tx-a' });
      const b = pagoPendiente({ _id: 'b', wompiTransactionId: 'tx-b' });
      build({ pendientes: [a, b] });
      wompi.getTransaction
        .mockRejectedValueOnce(new Error('pasarela caída'))
        .mockResolvedValue({ id: 'tx-b', status: 'APPROVED' });

      const r = await service.runBillingCycle();

      expect(r.reconciled).toBe(1);
      expect(wompi.getTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('3. cancelar respeta el período ya pagado', () => {
    it('con período pagado por delante, no se corta el servicio', async () => {
      const enUnMes = new Date(Date.now() + 30 * 86_400_000);
      const sub = build({ sub: suscripcion({ currentPeriodEnd: enUnMes }) });

      await service.cancel(BIZ);

      expect(sub.status).toBe('canceled');
      expect(sub.nextChargeAt).toBeUndefined();
      // Lo que se pagó se usa: la empresa sigue operando hasta esa fecha.
      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(sub.accessEndedAt).toBeUndefined();
    });

    it('sin período pagado por delante, el acceso se corta en el acto', async () => {
      const ayer = new Date(Date.now() - 86_400_000);
      const sub = build({ sub: suscripcion({ currentPeriodEnd: ayer }) });

      await service.cancel(BIZ);

      expect(businesses.updatePlan).toHaveBeenCalledWith(BIZ, {
        status: 'suspended',
      });
      expect(sub.accessEndedAt).toBeInstanceOf(Date);
    });

    it('quien nunca llegó a pagar tampoco conserva acceso', async () => {
      const sub = build({ sub: suscripcion({ currentPeriodEnd: undefined }) });

      await service.cancel(BIZ);

      expect(businesses.updatePlan).toHaveBeenCalledWith(BIZ, {
        status: 'suspended',
      });
      expect(sub.accessEndedAt).toBeInstanceOf(Date);
    });

    it('al vencer el período pagado, el barrido retira el acceso', async () => {
      const vencida = suscripcion({
        status: 'canceled',
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      });
      build({ canceladas: [vencida] });

      const r = await service.runBillingCycle();

      expect(businesses.updatePlan).toHaveBeenCalledWith(BIZ, {
        status: 'suspended',
      });
      expect(vencida.accessEndedAt).toBeInstanceOf(Date);
      expect(vencida.save).toHaveBeenCalled();
      expect(r.suspended).toBe(1);
    });

    it('el barrido busca solo canceladas a las que no se les retiró ya', async () => {
      build({ canceladas: [] });

      await service.runBillingCycle();

      const filtro = subs.find.mock.calls.find(
        (c: any[]) => c[0].status === 'canceled',
      )![0];
      expect(filtro.accessEndedAt).toBeNull();
      expect(filtro.currentPeriodEnd.$lte).toBeInstanceOf(Date);
    });

    it('no se suspende dos veces a la misma empresa', async () => {
      const yaRetirada = suscripcion({
        status: 'canceled',
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
        accessEndedAt: new Date(Date.now() - 3_600_000),
      });
      build({ canceladas: [yaRetirada] });

      await service.runBillingCycle();

      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });
  });

  describe('4. el día de cobro se conserva mes a mes', () => {
    /** Fin de período que resulta de aprobar una renovación. */
    async function renovarDesde(desde: string, cycle = 'monthly') {
      const sub = suscripcion({
        billingCycle: cycle,
        currentPeriodEnd: new Date(`${desde}T12:00:00Z`),
      });
      build({ sub });

      await service.handleWebhook({
        event: 'transaction.updated',
        data: { transaction: { id: 'tx', reference: 'r', status: 'APPROVED' } },
      });
      return (sub.currentPeriodEnd as Date).toISOString().slice(0, 10);
    }

    it('el 31 de enero pasa al 28 de febrero, no al 3 de marzo', async () => {
      expect(await renovarDesde('2027-01-31')).toBe('2027-02-28');
    });

    it('en año bisiesto el 31 de enero pasa al 29 de febrero', async () => {
      expect(await renovarDesde('2028-01-31')).toBe('2028-02-29');
    });

    it('el 30 de abril pasa al 30 de mayo, sin desplazarse', async () => {
      expect(await renovarDesde('2027-04-30')).toBe('2027-05-30');
    });

    it('un día que existe en todos los meses no se toca', async () => {
      expect(await renovarDesde('2027-03-15')).toBe('2027-04-15');
    });

    it('el trimestral avanza tres meses', async () => {
      expect(await renovarDesde('2027-01-15', 'quarterly')).toBe('2027-04-15');
    });

    it('el semestral avanza seis meses', async () => {
      expect(await renovarDesde('2027-01-15', 'semiannual')).toBe('2027-07-15');
    });

    it('el anual avanza doce meses', async () => {
      expect(await renovarDesde('2027-01-15', 'annual')).toBe('2028-01-15');
    });

    it('el 29 de febrero anual cae en el 28, no se salta a marzo', async () => {
      expect(await renovarDesde('2028-02-29', 'annual')).toBe('2029-02-28');
    });
  });
});
