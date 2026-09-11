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
import { ADD_ONS, DOCS_PER_PACKAGE } from '../../control/domain/plans';

/**
 * Compra de paquetes de documentos, consulta de estado y cancelación.
 *
 * La compra de documentos es la única venta de un solo pago del producto, y
 * cobra contra una tarjeta ya guardada: nadie vuelve a teclear nada, así que un
 * monto mal calculado se cobra sin que el cliente pueda revisarlo antes.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (businesses, wompi, subs, payments).
 */
describe('BillingService · documentos, estado y cancelación', () => {
  const BIZ = '68b0f3c2a1d4e5f6a7b8c9d0';

  let businesses: any;
  let wompi: any;
  let subs: any;
  let payments: any;
  let service: BillingService;
  let pago: any;

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
      nextChargeAt: new Date('2026-10-01T00:00:00Z') as Date | undefined,
      canceledAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  function build(sub: any, estadoPasarela = 'APPROVED') {
    businesses = {
      updatePlan: vi.fn().mockResolvedValue(undefined),
      addDocCredits: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue({ ownerEmail: 'duena@negocio.com' }),
      documentUsage: vi.fn().mockResolvedValue({
        used: 120,
        base: 5_000,
        credits: 1_000,
        period: '2026-09',
      }),
    };
    wompi = {
      configured: true,
      createTransaction: vi
        .fn()
        .mockResolvedValue({ id: 'tx-doc', status: estadoPasarela }),
    };
    subs = {
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(sub) })),
      findOneAndUpdate: vi.fn(),
    };
    payments = {
      create: vi.fn((doc: any) => {
        pago = { ...doc, _id: 'pay1', save: vi.fn().mockResolvedValue(undefined) };
        return Promise.resolve(pago);
      }),
      find: vi.fn(() => ({
        sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) }),
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

  describe('compra de documentos', () => {
    it('cobra el precio del paquete por la cantidad, en centavos', async () => {
      build(suscripcion());

      await service.purchaseDocs(BIZ, 3);

      expect(wompi.createTransaction.mock.calls[0][0].amountInCents).toBe(
        ADD_ONS.docPackage.price * 3 * 100,
      );
    });

    it('un solo paquete cuesta exactamente su precio', async () => {
      build(suscripcion());

      await service.purchaseDocs(BIZ, 1);

      expect(wompi.createTransaction.mock.calls[0][0].amountInCents).toBe(
        ADD_ONS.docPackage.price * 100,
      );
    });

    it('cobra contra la tarjeta ya guardada, sin pedirla de nuevo', async () => {
      build(suscripcion());

      await service.purchaseDocs(BIZ, 1);

      expect(wompi.createTransaction.mock.calls[0][0]).toMatchObject({
        paymentSourceId: 4321,
        customerEmail: 'duena@negocio.com',
      });
    });

    it('registra el pago como compra de documentos, con la cantidad', async () => {
      build(suscripcion());

      await service.purchaseDocs(BIZ, 2);

      expect(payments.create.mock.calls[0][0]).toMatchObject({
        kind: 'docPackage',
        docPackages: 2,
        businessId: BIZ,
        status: 'pending',
      });
    });

    it('al aprobarse acredita mil documentos por paquete', async () => {
      build(suscripcion());

      await service.purchaseDocs(BIZ, 2);

      expect(businesses.addDocCredits).toHaveBeenCalledWith(
        BIZ,
        DOCS_PER_PACKAGE * 2,
      );
    });

    it('comprar documentos no cambia el plan de la empresa', async () => {
      build(suscripcion());

      await service.purchaseDocs(BIZ, 1);

      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('si el cobro se rechaza no se acredita nada', async () => {
      build(suscripcion(), 'DECLINED');

      await service.purchaseDocs(BIZ, 5);

      expect(businesses.addDocCredits).not.toHaveBeenCalled();
      expect(pago.status).toBe('declined');
    });

    it('sin suscripción no hay tarjeta contra la cual cobrar', async () => {
      build(null);

      await expect(service.purchaseDocs(BIZ, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(wompi.createTransaction).not.toHaveBeenCalled();
    });

    it('con la suscripción cancelada tampoco se puede comprar', async () => {
      build(suscripcion({ status: 'canceled' }));

      await expect(service.purchaseDocs(BIZ, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(wompi.createTransaction).not.toHaveBeenCalled();
    });

    it('sin pasarela configurada no se intenta el cobro', async () => {
      build(suscripcion());
      wompi.configured = false;

      await expect(service.purchaseDocs(BIZ, 1)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(payments.create).not.toHaveBeenCalled();
    });

    it('cada compra lleva su propia referencia, con prefijo propio', async () => {
      build(suscripcion());

      await service.purchaseDocs(BIZ, 1);

      expect(payments.create.mock.calls[0][0].reference).toContain(
        `doc-${BIZ}-`,
      );
    });
  });

  describe('estado para el panel', () => {
    it('devuelve la suscripción, los pagos y el uso de documentos', async () => {
      build(suscripcion());

      const r = await service.status(BIZ);

      expect(r.subscription).not.toBeNull();
      expect(r.documents).toEqual({
        used: 120,
        base: 5_000,
        credits: 1_000,
        period: '2026-09',
      });
    });

    it('una empresa sin suscripción no revienta el panel', async () => {
      build(null);

      const r = await service.status(BIZ);

      expect(r.subscription).toBeNull();
      expect(r.payments).toEqual([]);
    });
  });

  describe('cancelación', () => {
    it('marca la suscripción cancelada con su fecha', async () => {
      const sub = suscripcion();
      build(sub);

      await service.cancel(BIZ);

      expect(sub.status).toBe('canceled');
      expect(sub.canceledAt).toBeInstanceOf(Date);
      expect(sub.save).toHaveBeenCalledOnce();
    });

    it('deja de programar cobros: cancelar no vuelve a cobrar', async () => {
      const sub = suscripcion();
      build(sub);

      await service.cancel(BIZ);

      expect(sub.nextChargeAt).toBeUndefined();
    });

    it('cancelar una empresa sin suscripción falla claro', async () => {
      build(null);

      await expect(service.cancel(BIZ)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('datos de configuración para el frontend', () => {
    it('sin pasarela configurada lo dice, en vez de dar llaves vacías', async () => {
      build(suscripcion());
      wompi.configured = false;
      wompi.environment = 'sandbox';

      const cfg = await service.config();

      expect(cfg.configured).toBe(false);
      expect(cfg.publicKey).toBe('');
      expect(cfg.acceptanceToken).toBe('');
    });

    it('configurada entrega la llave pública y la aceptación vigente', async () => {
      build(suscripcion());
      wompi.publicKey = 'pub_test_123';
      wompi.environment = 'sandbox';
      wompi.getAcceptance = vi.fn().mockResolvedValue({
        acceptanceToken: 'acc_1',
        permalink: 'https://wompi/tyc',
      });

      const cfg = await service.config();

      expect(cfg).toEqual({
        publicKey: 'pub_test_123',
        environment: 'sandbox',
        acceptanceToken: 'acc_1',
        permalink: 'https://wompi/tyc',
        configured: true,
      });
    });

    it('nunca expone la llave privada ni los secretos', async () => {
      build(suscripcion());
      wompi.publicKey = 'pub_test_123';
      wompi.environment = 'sandbox';
      wompi.getAcceptance = vi
        .fn()
        .mockResolvedValue({ acceptanceToken: 'acc_1', permalink: 'x' });

      const cfg = await service.config();

      const texto = JSON.stringify(cfg);
      expect(texto).not.toContain('prv_');
      expect(Object.keys(cfg)).toEqual([
        'publicKey',
        'environment',
        'acceptanceToken',
        'permalink',
        'configured',
      ]);
    });
  });
});
