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

/**
 * Webhook de la pasarela de pagos: es quien decide si una empresa queda activa
 * o suspendida.
 *
 * Tres cosas se juegan aquí y ninguna se puede reintentar a mano:
 *
 * - La FIRMA. Sin verificarla, cualquiera que conozca la URL podría activarle
 *   el plan a su empresa sin pagar.
 * - La IDEMPOTENCIA. La pasarela reenvía el mismo evento varias veces; si cada
 *   reenvío volviera a aplicar, un paquete de documentos se acreditaría dos o
 *   tres veces por un solo pago.
 * - No DEGRADAR. Un evento tardío con estado viejo no puede tumbar un pago que
 *   ya se aprobó y aplicó.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (businesses, wompi, subs, payments).
 */
describe('BillingService.handleWebhook', () => {
  const BIZ = '68b0f3c2a1d4e5f6a7b8c9d0';

  let businesses: any;
  let wompi: any;
  let subs: any;
  let payments: any;
  let service: BillingService;

  /** Pago pendiente a la espera de que la pasarela confirme. */
  function pago(over: Record<string, unknown> = {}) {
    return {
      _id: 'pay1',
      businessId: BIZ,
      reference: 'ref-1',
      kind: 'renewal',
      amountInCents: 9_900_000,
      status: 'pending',
      applied: false,
      plan: 'control',
      addOns: { payroll: true },
      wompiTransactionId: undefined as string | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  /** Suscripción vigente de la empresa. */
  function suscripcion(over: Record<string, unknown> = {}) {
    return {
      _id: 'sub1',
      businessId: BIZ,
      plan: 'control',
      billingCycle: 'monthly',
      status: 'active',
      failedAttempts: 0,
      currentPeriodEnd: undefined as Date | undefined,
      nextChargeAt: undefined as Date | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  function build(doc: any, sub: any = suscripcion()) {
    businesses = {
      updatePlan: vi.fn().mockResolvedValue(undefined),
      addDocCredits: vi.fn().mockResolvedValue(undefined),
    };
    wompi = { configured: true, verifyEvent: vi.fn().mockReturnValue(true) };
    subs = { findOne: vi.fn(() => ({ exec: () => Promise.resolve(sub) })) };
    payments = { findOne: vi.fn(() => ({ exec: () => Promise.resolve(doc) })) };

    service = new BillingService(
      businesses as never,
      wompi as never,
      subs as never,
      payments as never,
    );
    return { doc, sub };
  }

  /** Evento de la pasarela con el estado indicado. */
  function evento(status: string, reference = 'ref-1') {
    return {
      event: 'transaction.updated',
      data: { transaction: { id: 'tx-1', reference, status } },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('firma', () => {
    it('rechaza un evento con firma inválida sin tocar nada', async () => {
      build(pago());
      wompi.verifyEvent.mockReturnValue(false);

      await expect(service.handleWebhook(evento('APPROVED'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(payments.findOne).not.toHaveBeenCalled();
    });
  });

  describe('pago aprobado', () => {
    it('activa el plan de la empresa con sus complementos', async () => {
      const { doc } = build(pago());

      await service.handleWebhook(evento('APPROVED'));

      expect(doc.status).toBe('approved');
      expect(doc.applied).toBe(true);
      expect(businesses.updatePlan).toHaveBeenCalledWith(BIZ, {
        plan: 'control',
        addOns: { payroll: true },
        status: 'active',
      });
    });

    it('deja la suscripción al día y borra los intentos fallidos', async () => {
      const { sub } = build(pago(), suscripcion({ status: 'past_due', failedAttempts: 2 }));

      await service.handleWebhook(evento('APPROVED'));

      expect(sub.status).toBe('active');
      expect(sub.failedAttempts).toBe(0);
      expect(sub.lastTransactionId).toBe('tx-1');
    });

    it('el próximo cobro queda un mes después, y coincide con el fin de período', async () => {
      const { sub } = build(pago());

      await service.handleWebhook(evento('APPROVED'));

      const fin = sub.currentPeriodEnd as unknown as Date;
      expect(fin).toBeInstanceOf(Date);
      expect(sub.nextChargeAt).toBe(fin);
      expect(fin.getTime()).toBeGreaterThan(Date.now());
    });

    it('renovar antes de tiempo encadena el período, no lo recorta', async () => {
      // Si el período en curso todavía no termina, el nuevo arranca desde ese
      // fin, no desde hoy: pagar antes no puede costarle días al cliente.
      const finVigente = new Date(Date.now() + 20 * 24 * 3600 * 1000);
      const { sub } = build(pago(), suscripcion({ currentPeriodEnd: finVigente }));

      await service.handleWebhook(evento('APPROVED'));

      const nuevoFin = sub.currentPeriodEnd as unknown as Date;
      expect(nuevoFin.getTime()).toBeGreaterThan(finVigente.getTime());
    });

    it('un ciclo anual avanza un año, no un mes', async () => {
      const { sub } = build(pago(), suscripcion({ billingCycle: 'annual' }));

      await service.handleWebhook(evento('APPROVED'));

      const fin = sub.currentPeriodEnd as unknown as Date;
      const enUnMes = new Date();
      enUnMes.setMonth(enUnMes.getMonth() + 2);
      expect(fin.getTime()).toBeGreaterThan(enUnMes.getTime());
    });

    it('un paquete de documentos acredita cupo, no cambia el plan', async () => {
      const { doc } = build(pago({ kind: 'docPackage', docPackages: 2 }));

      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.addDocCredits).toHaveBeenCalledOnce();
      expect(businesses.addDocCredits.mock.calls[0][0]).toBe(BIZ);
      expect(businesses.addDocCredits.mock.calls[0][1]).toBeGreaterThan(0);
      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(doc.applied).toBe(true);
    });
  });

  describe('idempotencia', () => {
    it('el mismo evento repetido no vuelve a aplicar el pago', async () => {
      const { doc } = build(pago());

      await service.handleWebhook(evento('APPROVED'));
      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.updatePlan).toHaveBeenCalledOnce();
      expect(doc.applied).toBe(true);
    });

    it('un paquete de documentos no se acredita dos veces', async () => {
      build(pago({ kind: 'docPackage', docPackages: 1 }));

      await service.handleWebhook(evento('APPROVED'));
      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.addDocCredits).toHaveBeenCalledOnce();
    });

    it('un rechazo tardío no degrada un pago ya aplicado', async () => {
      // Los eventos pueden llegar desordenados: primero el aprobado, después
      // uno viejo de rechazo. El segundo no puede suspender a quien ya pagó.
      const { doc, sub } = build(pago());

      await service.handleWebhook(evento('APPROVED'));
      await service.handleWebhook(evento('DECLINED'));

      expect(doc.status).toBe('approved');
      expect(sub.status).toBe('active');
    });
  });

  describe('pago rechazado', () => {
    it('una renovación rechazada deja la suscripción en mora y suma un intento', async () => {
      const { doc, sub } = build(pago(), suscripcion({ failedAttempts: 1 }));

      await service.handleWebhook(evento('DECLINED'));

      expect(doc.status).toBe('declined');
      expect(sub.status).toBe('past_due');
      expect(sub.failedAttempts).toBe(2);
      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('un error de la pasarela cuenta igual que un rechazo', async () => {
      const { sub } = build(pago());

      await service.handleWebhook(evento('ERROR'));

      expect(sub.status).toBe('past_due');
    });

    it('un alta fallida no pone en mora: la suscripción sigue pendiente', async () => {
      const { sub } = build(
        pago({ kind: 'subscription' }),
        suscripcion({ status: 'pending' }),
      );

      await service.handleWebhook(evento('DECLINED'));

      expect(sub.status).toBe('pending');
      expect(sub.failedAttempts).toBe(1);
    });

    it('un estado en curso no cambia la suscripción: todavía no se sabe', async () => {
      const { doc, sub } = build(pago());

      await service.handleWebhook(evento('PENDING'));

      expect(doc.status).toBe('pending');
      expect(sub.status).toBe('active');
    });
  });

  describe('eventos que no aplican', () => {
    it('ignora eventos de otro tipo', async () => {
      build(pago());

      const r = await service.handleWebhook({
        event: 'nequi_token.updated',
        data: { transaction: { id: 'tx-1', reference: 'ref-1', status: 'APPROVED' } },
      });

      expect(r).toEqual({ received: true });
      expect(payments.findOne).not.toHaveBeenCalled();
    });

    it('una referencia desconocida se acusa recibo y se descarta', async () => {
      build(null);

      const r = await service.handleWebhook(evento('APPROVED', 'ref-fantasma'));

      expect(r).toEqual({ received: true });
      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('un evento sin referencia ni estado no revienta', async () => {
      build(pago());

      const r = await service.handleWebhook({
        event: 'transaction.updated',
        data: { transaction: { id: 'tx-1' } },
      });

      expect(r).toEqual({ received: true });
    });
  });
});
