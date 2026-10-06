import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';

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

/**
 * Tarjeta guardada y confirmación de un cobro pendiente.
 *
 * Los dos cubren el mismo hueco por lados distintos: el token que devuelve el
 * widget de Wompi es de un solo uso y vive en la pestaña del navegador, y la
 * transacción nace SIEMPRE en `PENDING` y se aprueba después. Sin guardar la
 * tarjeta, el dueño la escribía de nuevo en cada recarga; sin poder consultar
 * el cobro, la pantalla se quedaba en "pago en proceso" hasta el barrido del
 * cron aunque la plata ya estuviera cobrada.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (businesses, wompi, subs, payments, paymentMethods).
 */
describe('BillingService · tarjeta guardada y confirmación del cobro', () => {
  const BIZ = 'biz1';

  let businesses: any;
  let wompi: any;
  let subs: any;
  let payments: any;
  let paymentMethods: any;
  let service: BillingService;
  /** Fila de la tarjeta guardada (lo que hay en la base). */
  let tarjeta: any;
  /** Pago que devuelve la base al consultarlo por referencia. */
  let pago: any;
  /** Suscripción de la empresa. */
  let suscripcion: any;

  function build(
    opts: {
      tarjeta?: any;
      pago?: any;
      estadoConsulta?: string;
      configurada?: boolean;
      empresa?: any;
    } = {},
  ) {
    tarjeta = opts.tarjeta ?? null;
    pago =
      opts.pago === undefined
        ? {
            _id: 'pay1',
            businessId: BIZ,
            reference: 'sub-biz1-1',
            kind: 'subscription',
            plan: 'control',
            addOns: {},
            status: 'pending',
            applied: false,
            wompiTransactionId: 'tx-1',
            save: vi.fn().mockResolvedValue(undefined),
          }
        : opts.pago;
    suscripcion = {
      _id: 'sub1',
      businessId: BIZ,
      plan: 'control',
      billingCycle: 'monthly',
      status: 'pending',
      failedAttempts: 0,
      currentPeriodEnd: undefined as Date | undefined,
      nextChargeAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };

    businesses = {
      updatePlan: vi.fn().mockResolvedValue(undefined),
      addDocCredits: vi.fn().mockResolvedValue(undefined),
      documentUsage: vi.fn().mockResolvedValue({
        used: 0,
        base: 5_000,
        credits: 0,
        period: '2026-09',
      }),
      findById: vi.fn().mockResolvedValue(
        opts.empresa === undefined
          ? { _id: BIZ, ownerEmail: 'duena@negocio.com' }
          : opts.empresa,
      ),
    };
    wompi = {
      configured: opts.configurada ?? true,
      createPaymentSource: vi
        .fn()
        .mockResolvedValue({ id: 9001, brand: 'VISA', lastFour: '4242' }),
      createTransaction: vi
        .fn()
        .mockResolvedValue({ id: 'tx-1', status: 'PENDING' }),
      getTransaction: vi.fn().mockResolvedValue({
        id: 'tx-1',
        status: opts.estadoConsulta ?? 'APPROVED',
      }),
    };
    subs = {
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(suscripcion) })),
      findOneAndUpdate: vi.fn(() => Promise.resolve(suscripcion)),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve(undefined) })),
    };
    payments = {
      create: vi.fn((doc: any) =>
        Promise.resolve({ ...doc, _id: 'pay1', save: vi.fn() }),
      ),
      findOne: vi.fn((filter: any) => ({
        exec: () =>
          Promise.resolve(
            pago && filter.businessId === pago.businessId ? pago : null,
          ),
      })),
      find: vi.fn(() => ({
        sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) }),
      })),
    };
    paymentMethods = {
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(tarjeta) })),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve(undefined) })),
    };

    service = new BillingService(
      businesses as never,
      wompi as never,
      subs as never,
      payments as never,
      paymentMethods as never,
    );
  }

  const registro = {
    cardToken: 'tok_test_abc',
    acceptanceToken: 'acc_test_abc',
  };

  /** Campos con los que se guardó la tarjeta. */
  function guardada(): any {
    return paymentMethods.updateOne.mock.calls[0][1];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    build();
  });

  describe('registrar la tarjeta sin cobrar', () => {
    it('cambia el token de un uso por una fuente de pago permanente', async () => {
      build({ tarjeta: { businessId: BIZ, paymentSourceId: 9001 } });

      await service.savePaymentMethod(BIZ, registro as never);

      expect(wompi.createPaymentSource).toHaveBeenCalledWith({
        token: 'tok_test_abc',
        customerEmail: 'duena@negocio.com',
        acceptanceToken: 'acc_test_abc',
        acceptPersonalAuth: undefined,
      });
    });

    it('no cobra nada al registrarla', async () => {
      build({ tarjeta: { businessId: BIZ, paymentSourceId: 9001 } });

      await service.savePaymentMethod(BIZ, registro as never);

      expect(wompi.createTransaction).not.toHaveBeenCalled();
    });

    it('la guarda para la empresa, con marca y últimos cuatro dígitos', async () => {
      build({ tarjeta: { businessId: BIZ, paymentSourceId: 9001 } });

      await service.savePaymentMethod(BIZ, registro as never);

      expect(guardada()).toMatchObject({
        businessId: BIZ,
        paymentSourceId: 9001,
        brand: 'VISA',
        lastFour: '4242',
      });
      expect(paymentMethods.updateOne.mock.calls[0][2]).toMatchObject({
        upsert: true,
      });
    });

    it('apunta la suscripción existente a la tarjeta nueva', async () => {
      // Las renovaciones se cobran contra `Subscription.paymentSourceId`: sin
      // esto, quien cambia de tarjeta ve la nueva en pantalla mientras el cron
      // le sigue cobrando a la vieja.
      build({ tarjeta: { businessId: BIZ, paymentSourceId: 9001 } });

      await service.savePaymentMethod(BIZ, registro as never);

      expect(subs.updateOne).toHaveBeenCalledWith(
        { businessId: BIZ },
        { paymentSourceId: 9001, customerEmail: 'duena@negocio.com' },
      );
    });

    it('sin aceptar los términos de Wompi no se registra', async () => {
      await expect(
        service.savePaymentMethod(BIZ, { cardToken: 'tok_x' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(wompi.createPaymentSource).not.toHaveBeenCalled();
    });

    it('sin pasarela configurada avisa en vez de llamar a Wompi sin llaves', async () => {
      build({ configurada: false });

      await expect(
        service.savePaymentMethod(BIZ, registro as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(wompi.createPaymentSource).not.toHaveBeenCalled();
    });

    it('una empresa que no existe no registra tarjeta', async () => {
      build({ empresa: null });

      await expect(
        service.savePaymentMethod(BIZ, registro as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(wompi.createPaymentSource).not.toHaveBeenCalled();
    });

    it('el estado de facturación devuelve la tarjeta guardada', async () => {
      build({
        tarjeta: { businessId: BIZ, paymentSourceId: 9001, lastFour: '4242' },
      });

      const estado = await service.status(BIZ);

      expect(estado.paymentMethod).toMatchObject({ lastFour: '4242' });
    });
  });

  describe('contratar con la tarjeta ya registrada', () => {
    const alta = { plan: 'control' };

    it('no vuelve a pedir la tarjeta: cobra contra la guardada', async () => {
      build({ tarjeta: { businessId: BIZ, paymentSourceId: 9001 } });

      await service.subscribe(BIZ, alta as never);

      expect(wompi.createPaymentSource).not.toHaveBeenCalled();
      expect(wompi.createTransaction.mock.calls[0][0].paymentSourceId).toBe(9001);
    });

    it('sin tarjeta guardada ni tarjeta nueva no cobra: pide registrarla', async () => {
      await expect(service.subscribe(BIZ, alta as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(wompi.createTransaction).not.toHaveBeenCalled();
    });

    it('una tarjeta nueva en el alta también queda guardada', async () => {
      // Antes la fuente de pago solo se guardaba dentro de la suscripción, así
      // que al recargar la página la tarjeta "registrada" desaparecía.
      await service.subscribe(BIZ, { ...alta, ...registro } as never);

      expect(guardada()).toMatchObject({
        paymentSourceId: 9001,
        lastFour: '4242',
      });
    });
  });

  describe('confirmar un cobro pendiente', () => {
    it('le pregunta a la pasarela por la transacción del pago', async () => {
      await service.syncPayment(BIZ, 'sub-biz1-1');

      expect(wompi.getTransaction).toHaveBeenCalledWith('tx-1');
    });

    it('aprobado en la pasarela: activa el plan y lo reporta al frontend', async () => {
      const r = await service.syncPayment(BIZ, 'sub-biz1-1');

      expect(businesses.updatePlan).toHaveBeenCalledWith(BIZ, {
        plan: 'control',
        addOns: {},
        status: 'active',
      });
      expect(r).toMatchObject({ status: 'approved', applied: true });
    });

    it('sigue pendiente en la pasarela: no activa nada', async () => {
      build({ estadoConsulta: 'PENDING' });

      const r = await service.syncPayment(BIZ, 'sub-biz1-1');

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(r.status).toBe('pending');
    });

    it('rechazado en la pasarela: queda rechazado y no activa el plan', async () => {
      build({ estadoConsulta: 'DECLINED' });

      const r = await service.syncPayment(BIZ, 'sub-biz1-1');

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(r.status).toBe('declined');
    });

    it('un pago ya resuelto no se vuelve a consultar', async () => {
      build({
        pago: {
          businessId: BIZ,
          reference: 'sub-biz1-1',
          status: 'approved',
          applied: true,
          wompiTransactionId: 'tx-1',
          save: vi.fn(),
        },
      });

      const r = await service.syncPayment(BIZ, 'sub-biz1-1');

      expect(wompi.getTransaction).not.toHaveBeenCalled();
      expect(r).toMatchObject({ status: 'approved', applied: true });
    });

    it('si la pasarela no responde devuelve lo guardado, no revienta la pantalla', async () => {
      // Consultar es un extra sobre el webhook: que falle no puede tumbar la
      // página donde el dueño está esperando su plan.
      wompi.getTransaction.mockRejectedValue(new Error('timeout'));

      const r = await service.syncPayment(BIZ, 'sub-biz1-1');

      expect(r.status).toBe('pending');
    });

    it('un pago de otra empresa no se consulta ni se toca', async () => {
      // El filtro lleva businessId: si no, cualquiera con una referencia ajena
      // podría mirar —y disparar— cobros de otro negocio.
      await expect(
        service.syncPayment('otra-empresa', 'sub-biz1-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(wompi.getTransaction).not.toHaveBeenCalled();
    });
  });
});
