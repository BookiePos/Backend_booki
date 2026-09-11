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
import {
  ADD_ONS,
  CYCLE_BILLED_MONTHS,
  CYCLE_MONTHS,
  PLAN_PRICING,
  planPrice,
  roundPrice,
} from '../../control/domain/plans';

/**
 * Alta y cambio de suscripción: el primer cobro y el monto que queda grabado
 * para todas las renovaciones siguientes.
 *
 * Es el punto donde se decide cuánto se le cobra al cliente CADA MES a partir de
 * ahí. Un error en ese monto no se ve una vez, se repite indefinidamente y en la
 * dirección equivocada: de menos, se regala producto; de más, se cobra sin
 * autorización y se pierde al cliente.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (businesses, wompi, subs, payments).
 */
describe('BillingService.subscribe', () => {
  const BIZ = '68b0f3c2a1d4e5f6a7b8c9d0';

  let businesses: any;
  let wompi: any;
  let subs: any;
  let payments: any;
  let service: BillingService;
  /** Suscripción resultante del upsert. */
  let suscripcion: any;
  /** Pago creado para el primer cobro. */
  let pago: any;

  function build(over: { estadoPasarela?: string; empresa?: any } = {}) {
    suscripcion = { _id: 'sub1', businessId: BIZ, billingCycle: 'monthly' };
    businesses = {
      updatePlan: vi.fn().mockResolvedValue(undefined),
      addDocCredits: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue(
        over.empresa === undefined
          ? { _id: BIZ, ownerEmail: 'duena@negocio.com' }
          : over.empresa,
      ),
    };
    wompi = {
      configured: true,
      createPaymentSource: vi.fn().mockResolvedValue(4321),
      createTransaction: vi.fn().mockResolvedValue({
        id: 'tx-1',
        status: over.estadoPasarela ?? 'PENDING',
      }),
    };
    subs = {
      findOneAndUpdate: vi.fn((_f: unknown, doc: any) => {
        suscripcion = { ...suscripcion, ...doc, save: vi.fn() };
        return Promise.resolve(suscripcion);
      }),
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(suscripcion) })),
    };
    payments = {
      create: vi.fn((doc: any) => {
        pago = { ...doc, _id: 'pay1', save: vi.fn().mockResolvedValue(undefined) };
        return Promise.resolve(pago);
      }),
    };

    service = new BillingService(
      businesses as never,
      wompi as never,
      subs as never,
      payments as never,
    );
  }

  const alta = {
    plan: 'control',
    cardToken: 'tok_test_abc',
    acceptanceToken: 'acc_test_abc',
  };

  /** Campos con los que se guardó la suscripción. */
  function guardada(): any {
    return subs.findOneAndUpdate.mock.calls[0][1];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    build();
  });

  describe('validaciones previas', () => {
    it('sin pasarela configurada no cobra: avisa que faltan las llaves', async () => {
      build();
      wompi.configured = false;

      await expect(service.subscribe(BIZ, alta as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(wompi.createPaymentSource).not.toHaveBeenCalled();
    });

    it('una empresa que no existe no se suscribe', async () => {
      build({ empresa: null });

      await expect(service.subscribe(BIZ, alta as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(wompi.createPaymentSource).not.toHaveBeenCalled();
    });

    it('un plan inventado se rechaza antes de tocar la tarjeta', async () => {
      await expect(
        service.subscribe(BIZ, { ...alta, plan: 'platino' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(wompi.createPaymentSource).not.toHaveBeenCalled();
    });
  });

  describe('tarjeta y correo', () => {
    it('registra la tarjeta con el token y la aceptación que envió el cliente', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(wompi.createPaymentSource).toHaveBeenCalledWith({
        token: 'tok_test_abc',
        customerEmail: 'duena@negocio.com',
        acceptanceToken: 'acc_test_abc',
      });
    });

    it('guarda la fuente de pago para poder cobrar las renovaciones solo', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(guardada().paymentSourceId).toBe(4321);
    });

    it('sin correo indicado usa el del dueño de la empresa', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(guardada().customerEmail).toBe('duena@negocio.com');
    });

    it('un correo de facturación propio tiene prioridad', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        customerEmail: 'contabilidad@negocio.com',
      } as never);

      expect(guardada().customerEmail).toBe('contabilidad@negocio.com');
    });
  });

  describe('monto recurrente', () => {
    it('plan mensual: el precio del plan en centavos', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(guardada().amountInCents).toBe(PLAN_PRICING.control.monthly * 100);
    });

    it('plan anual: el precio anual, no doce mensualidades', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        billingCycle: 'annual',
      } as never);

      expect(guardada().amountInCents).toBe(PLAN_PRICING.control.annual * 100);
    });

    it('un ciclo desconocido cae a mensual, no a gratis', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        billingCycle: 'semanal',
      } as never);

      expect(guardada().billingCycle).toBe('monthly');
      expect(guardada().amountInCents).toBe(PLAN_PRICING.control.monthly * 100);
    });

    it('cada plan cobra su propio precio', async () => {
      for (const plan of ['punto', 'negocio', 'control', 'cadena'] as const) {
        build();
        await service.subscribe(BIZ, { ...alta, plan } as never);
        expect(guardada().amountInCents).toBe(PLAN_PRICING[plan].monthly * 100);
      }
    });

    it('el complemento de nómina suma su mensualidad', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { payroll: true },
      } as never);

      expect(guardada().amountInCents).toBe(
        (PLAN_PRICING.control.monthly + ADD_ONS.payroll.price) * 100,
      );
    });

    it('las sedes adicionales se cobran por unidad', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { extraSedes: 3 },
      } as never);

      expect(guardada().amountInCents).toBe(
        (PLAN_PRICING.control.monthly + 3 * ADD_ONS.extraSede.price) * 100,
      );
    });

    it('los empleados adicionales se cobran por unidad', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { extraEmployees: 4 },
      } as never);

      expect(guardada().amountInCents).toBe(
        (PLAN_PRICING.control.monthly + 4 * ADD_ONS.extraEmployee.price) * 100,
      );
    });

    it('varios complementos se suman entre sí', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { payroll: true, extraSedes: 2, extraEmployees: 5 },
      } as never);

      const esperado =
        PLAN_PRICING.control.monthly +
        ADD_ONS.payroll.price +
        2 * ADD_ONS.extraSede.price +
        5 * ADD_ONS.extraEmployee.price;
      expect(guardada().amountInCents).toBe(esperado * 100);
    });

    it('los complementos llevan el mismo descuento del ciclo que el plan', async () => {
      // Quien paga por adelantado lo hace por todo lo contratado, no solo por
      // el plan: en el anual se cobran 10 meses de complemento, no 12.
      await service.subscribe(BIZ, {
        ...alta,
        billingCycle: 'annual',
        addOns: { payroll: true },
      } as never);

      expect(guardada().amountInCents).toBe(
        (planPrice('control', 'annual') +
          roundPrice(ADD_ONS.payroll.price * CYCLE_BILLED_MONTHS.annual)) *
          100,
      );
    });

    it('trimestral y semestral cobran su precio de lista', async () => {
      for (const cycle of ['quarterly', 'semiannual'] as const) {
        build();
        await service.subscribe(BIZ, { ...alta, billingCycle: cycle } as never);
        expect(guardada().billingCycle).toBe(cycle);
        expect(guardada().amountInCents).toBe(planPrice('control', cycle) * 100);
      }
    });

    it('el ciclo largo sale más barato por mes que el mensual', async () => {
      // Es la razón de existir del ciclo largo: si no fuese más barato, nadie
      // pagaría por adelantado.
      const porMes: number[] = [];
      for (const cycle of [
        'monthly',
        'quarterly',
        'semiannual',
        'annual',
      ] as const) {
        build();
        await service.subscribe(BIZ, { ...alta, billingCycle: cycle } as never);
        porMes.push(guardada().amountInCents / CYCLE_MONTHS[cycle]);
      }

      expect(porMes[1]).toBeLessThan(porMes[0]!);
      expect(porMes[2]).toBeLessThan(porMes[1]!);
      expect(porMes[3]).toBeLessThan(porMes[2]!);
    });

    it('el monto siempre es un entero de centavos', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { payroll: true, extraEmployees: 7 },
      } as never);

      expect(Number.isInteger(guardada().amountInCents)).toBe(true);
    });
  });

  describe('complementos que no se cobran', () => {
    it('un complemento en falso no suma', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { payroll: false },
      } as never);

      expect(guardada().amountInCents).toBe(PLAN_PRICING.control.monthly * 100);
      expect(guardada().addOns).toEqual({});
    });

    it('una cantidad en cero no se guarda ni se cobra', async () => {
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { extraSedes: 0, extraEmployees: 0 },
      } as never);

      expect(guardada().addOns).toEqual({});
    });

    it('una cantidad negativa no descuenta del precio', async () => {
      // Defensa de fondo: el DTO ya exige mínimo cero, pero un negativo aquí
      // rebajaría la mensualidad del plan.
      await service.subscribe(BIZ, {
        ...alta,
        addOns: { extraSedes: -10 },
      } as never);

      expect(guardada().amountInCents).toBe(PLAN_PRICING.control.monthly * 100);
    });
  });

  describe('registro del cobro', () => {
    it('crea un pago de alta ligado a la suscripción y a la empresa', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(payments.create.mock.calls[0][0]).toMatchObject({
        businessId: BIZ,
        subscriptionId: 'sub1',
        kind: 'subscription',
        status: 'pending',
        plan: 'control',
      });
    });

    it('el pago guarda el monto que se va a cobrar', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(payments.create.mock.calls[0][0].amountInCents).toBe(
        guardada().amountInCents,
      );
    });

    it('cobra a la pasarela ese mismo monto, contra la tarjeta registrada', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(wompi.createTransaction).toHaveBeenCalledWith({
        amountInCents: PLAN_PRICING.control.monthly * 100,
        reference: expect.stringContaining(`sub-${BIZ}-`),
        customerEmail: 'duena@negocio.com',
        paymentSourceId: 4321,
      });
    });

    it('anota el identificador de la transacción en el pago', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(pago.wompiTransactionId).toBe('tx-1');
      expect(pago.save).toHaveBeenCalled();
    });

    it('devuelve al cliente lo que necesita para seguir el cobro', async () => {
      const r = await service.subscribe(BIZ, alta as never);

      expect(r).toEqual({
        reference: expect.stringContaining(`sub-${BIZ}-`),
        transactionId: 'tx-1',
        status: 'PENDING',
      });
    });
  });

  describe('estado según responda la pasarela', () => {
    it('aprobado al instante: activa el plan de la empresa', async () => {
      build({ estadoPasarela: 'APPROVED' });

      await service.subscribe(BIZ, alta as never);

      expect(businesses.updatePlan).toHaveBeenCalledWith(BIZ, {
        plan: 'control',
        addOns: {},
        status: 'active',
      });
    });

    it('pendiente: no activa nada todavía', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(guardada().status).toBe('pending');
    });

    it('rechazado: no activa el plan y cuenta el intento fallido', async () => {
      build({ estadoPasarela: 'DECLINED' });

      await service.subscribe(BIZ, alta as never);

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(suscripcion.failedAttempts).toBe(1);
    });
  });

  describe('cambio de plan', () => {
    it('reutiliza la suscripción de la empresa, no crea una segunda', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(subs.findOneAndUpdate.mock.calls[0][0]).toEqual({
        businessId: BIZ,
      });
      expect(subs.findOneAndUpdate.mock.calls[0][2]).toMatchObject({
        upsert: true,
      });
    });

    it('al cambiar de plan se reinicia el contador de intentos fallidos', async () => {
      await service.subscribe(BIZ, alta as never);

      expect(guardada().failedAttempts).toBe(0);
    });

    it('el plan nuevo queda grabado con su monto nuevo', async () => {
      await service.subscribe(BIZ, { ...alta, plan: 'cadena' } as never);

      expect(guardada().plan).toBe('cadena');
      expect(guardada().amountInCents).toBe(PLAN_PRICING.cadena.monthly * 100);
    });
  });
});
