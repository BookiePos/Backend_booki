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
/** Evalúa el subconjunto de filtros de Mongo que usa el servicio. */
function coincide(doc: any, filtro: Record<string, any>): boolean {
  return Object.entries(filtro).every(([k, cond]) => {
    if (k === '_id') return true;
    if (k === '$or') return (cond as any[]).some((c) => coincide(doc, c));
    if (k === '$and') return (cond as any[]).every((c) => coincide(doc, c));
    const v = doc[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$ne' in cond) return v !== cond.$ne;
      if ('$lte' in cond) return v != null && v <= cond.$lte;
      if ('$in' in cond) return cond.$in.includes(v);
      return false;
    }
    if (cond === null) return v == null;
    return v === cond;
  });
}

/** Aplica `$set`, `$unset` y `$addToSet` sobre el documento. */
function aplicar(doc: any, cambio: Record<string, any>): void {
  Object.assign(doc, cambio.$set ?? {});
  for (const k of Object.keys(cambio.$unset ?? {})) delete doc[k];
  for (const [k, v] of Object.entries(cambio.$addToSet ?? {})) {
    doc[k] = Array.from(new Set([...(doc[k] ?? []), v]));
  }
}

describe('BillingService.handleWebhook', () => {
  const BIZ = '68b0f3c2a1d4e5f6a7b8c9d0';

  let businesses: any;
  let wompi: any;
  let subs: any;
  let payments: any;
  let paymentMethods: any;
  /** Tarjeta guardada de la empresa; `null` = nunca registró una. */
  let tarjetaGuardada: any;
  let service: BillingService;
  /**
   * Estado que la API de la pasarela devuelve al consultar la transacción. Lo
   * fija `evento()`: un evento legítimo dice lo mismo que la API.
   */
  let estadoReal: string;
  /** Órdenes con que los barridos pidieron los pagos. */
  let ordenes: any[];

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
    wompi = {
      configured: true,
      verifyEvent: vi.fn().mockReturnValue(true),
      // La transacción tal como la reporta la API: coincide con el pago.
      getTransaction: vi.fn((id: string) =>
        Promise.resolve({
          id,
          status: estadoReal,
          reference: doc?.reference,
          amount_in_cents: doc?.amountInCents,
          currency: 'COP',
        }),
      ),
    };
    subs = {
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(sub) })),
      find: vi.fn(() => ({ exec: () => Promise.resolve([]) })),
    };
    ordenes = [];
    payments = {
      // Barridos: devuelve el pago si cumple el filtro y anota el orden pedido.
      find: vi.fn((filtro: any) => {
        const res = () => Promise.resolve(doc && coincide(doc, filtro) ? [doc] : []);
        return {
          sort: (o: any) => {
            ordenes.push(o);
            return { limit: () => ({ exec: res }) };
          },
          exec: res,
        };
      }),
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(doc) })),
      // Operaciones atómicas como las haría Mongo: comprobar y cambiar en un
      // solo paso sobre el documento "de la base" (`doc`).
      findOneAndUpdate: vi.fn((filtro: any, cambio: any) => ({
        exec: () => {
          if (!doc || !coincide(doc, filtro)) return Promise.resolve(null);
          aplicar(doc, cambio);
          return Promise.resolve(doc);
        },
      })),
      updateOne: vi.fn((filtro: any, cambio: any) => ({
        exec: () => {
          if (!doc || !coincide(doc, filtro)) {
            return Promise.resolve({ modifiedCount: 0 });
          }
          aplicar(doc, cambio);
          return Promise.resolve({ modifiedCount: 1 });
        },
      })),
    };

    tarjetaGuardada = tarjetaGuardada ?? null;
    paymentMethods = {
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(tarjetaGuardada) })),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve(undefined) })),
    };

    service = new BillingService(
      businesses as never,
      wompi as never,
      subs as never,
      payments as never,
      paymentMethods as never,
    );
    return { doc, sub };
  }

  /** Evento de la pasarela con el estado indicado. */
  function evento(status: string, reference = 'ref-1') {
    estadoReal = status;
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

  describe('verificación contra la API de la pasarela', () => {
    it('consulta la transacción del evento antes de aplicar', async () => {
      build(pago());

      await service.handleWebhook(evento('APPROVED'));

      expect(wompi.getTransaction).toHaveBeenCalledWith('tx-1');
      expect(businesses.updatePlan).toHaveBeenCalledOnce();
    });

    it('no aplica si la API dice otro estado que el evento', async () => {
      // Un evento viejo de aprobado reenviado sobre una transacción anulada.
      const { doc } = build(pago());
      const e = evento('APPROVED');
      estadoReal = 'VOIDED';

      await service.handleWebhook(e);

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(doc.applied).toBe(false);
      expect(doc.status).toBe('pending');
    });

    it('no aplica si el monto cobrado no es el del pago', async () => {
      const { doc } = build(pago());
      wompi.getTransaction.mockResolvedValueOnce({
        id: 'tx-1',
        status: 'APPROVED',
        reference: 'ref-1',
        amount_in_cents: 100,
        currency: 'COP',
      });

      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(doc.applied).toBe(false);
    });

    it('no aplica si la moneda no es COP', async () => {
      build(pago());
      wompi.getTransaction.mockResolvedValueOnce({
        id: 'tx-1',
        status: 'APPROVED',
        reference: 'ref-1',
        amount_in_cents: 9_900_000,
        currency: 'USD',
      });

      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('no aplica si la transacción es de otra referencia', async () => {
      // Una transacción aprobada barata de otra compra no paga este plan.
      build(pago());
      wompi.getTransaction.mockResolvedValueOnce({
        id: 'tx-1',
        status: 'APPROVED',
        reference: 'otra-ref',
        amount_in_cents: 9_900_000,
        currency: 'COP',
      });

      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('no aplica si el evento trae otra transacción que la del pago', async () => {
      build(pago({ wompiTransactionId: 'tx-original' }));

      await service.handleWebhook(evento('APPROVED'));

      expect(wompi.getTransaction).not.toHaveBeenCalled();
      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('si la API no responde, falla para que la pasarela reintente', async () => {
      const { doc } = build(pago());
      wompi.getTransaction.mockRejectedValueOnce(new Error('timeout'));

      await expect(service.handleWebhook(evento('APPROVED'))).rejects.toThrow();
      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(doc.applied).toBe(false);
    });
  });

  describe('aplicación única ante llamadas concurrentes', () => {
    it('dos webhooks a la vez extienden la suscripción una sola vez', async () => {
      // Cada request lee SU copia del pago (applied: false en las dos); solo
      // la reserva atómica en la base decide quién aplica.
      const base = pago();
      const sub = suscripcion();
      build(base, sub);
      payments.findOne = vi.fn(() => ({
        exec: () => Promise.resolve({ ...base, save: vi.fn() }),
      }));

      await Promise.all([
        service.handleWebhook(evento('APPROVED')),
        service.handleWebhook(evento('APPROVED')),
      ]);

      expect(businesses.updatePlan).toHaveBeenCalledOnce();
      expect(sub.save).toHaveBeenCalledOnce();
    });

    it('webhook y consulta del frontend a la vez no acreditan dos veces', async () => {
      const base = pago({ kind: 'docPackage', docPackages: 1, wompiTransactionId: 'tx-1' });
      build(base);
      payments.findOne = vi.fn(() => ({
        exec: () => Promise.resolve({ ...base, save: vi.fn() }),
      }));
      estadoReal = 'APPROVED';

      await Promise.all([
        service.handleWebhook(evento('APPROVED')),
        service.syncPayment(BIZ, 'ref-1'),
      ]);

      expect(businesses.addDocCredits).toHaveBeenCalledOnce();
    });
  });

  describe('efectos que fallan a mitad', () => {
    it('si activar el plan falla, el pago NO queda aplicado y el reintento lo completa', async () => {
      const { doc, sub } = build(pago());
      businesses.updatePlan.mockRejectedValueOnce(new Error('control-plane caído'));

      await expect(service.handleWebhook(evento('APPROVED'))).rejects.toThrow();
      expect(doc.applied).toBe(false);
      expect(sub.save).not.toHaveBeenCalled();

      // Wompi reintenta al no recibir 200: esta vez sí se aplica, una vez.
      await service.handleWebhook(evento('APPROVED'));
      expect(doc.applied).toBe(true);
      expect(sub.save).toHaveBeenCalledOnce();
    });

    it('si acreditar documentos falla, el reintento los acredita una sola vez', async () => {
      const { doc } = build(pago({ kind: 'docPackage', docPackages: 1 }));
      businesses.addDocCredits.mockRejectedValueOnce(new Error('timeout'));

      await expect(service.handleWebhook(evento('APPROVED'))).rejects.toThrow();
      await service.handleWebhook(evento('APPROVED'));
      await service.handleWebhook(evento('APPROVED'));

      expect(doc.applied).toBe(true);
      // 1 intento fallido + 1 exitoso; el tercer evento ya no acredita.
      expect(businesses.addDocCredits).toHaveBeenCalledTimes(2);
    });

    it('un paso ya hecho no se repite al retomar (documentos no se duplican)', async () => {
      // El proceso murió después de acreditar y antes de cerrar el pago.
      const { doc } = build(
        pago({
          kind: 'docPackage',
          docPackages: 1,
          status: 'approved',
          applyVersion: 2,
          effectsDone: ['docCredits'],
        }),
      );

      await service.runBillingCycle();

      expect(businesses.addDocCredits).not.toHaveBeenCalled();
      expect(doc.applied).toBe(true);
    });

    it('el barrido retoma un pago aprobado que quedó sin efectos', async () => {
      const { doc, sub } = build(pago({ status: 'approved', applyVersion: 2 }));

      await service.runBillingCycle();

      expect(businesses.updatePlan).toHaveBeenCalledOnce();
      expect(sub.save).toHaveBeenCalledOnce();
      expect(doc.applied).toBe(true);
    });

    it('no pisa una aplicación en curso de otro proceso', async () => {
      build(pago({ status: 'approved', applyVersion: 2, applyingAt: new Date() }));

      await service.runBillingCycle();

      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('una reserva vencida (proceso muerto) se puede retomar', async () => {
      const { doc } = build(
        pago({
          status: 'approved',
          applyVersion: 2,
          applyingAt: new Date(Date.now() - 60 * 60 * 1000),
        }),
      );

      await service.runBillingCycle();

      expect(businesses.updatePlan).toHaveBeenCalledOnce();
      expect(doc.applied).toBe(true);
    });
  });

  describe('pagos aprobados por el código anterior', () => {
    // El código anterior marcaba `approved` y `applied` juntos, sin
    // `applyVersion`. Una fila así no dice qué efectos se hicieron: re-aplicarla
    // podría acreditar documentos o abrir un período por segunda vez. Se deja
    // para revisión a mano (src/datos/2026-10-pagos-aprobados-legado-informe.ts).
    it('el barrido no re-aplica un pago aprobado sin marca de versión', async () => {
      const { doc } = build(pago({ kind: 'docPackage', docPackages: 1, status: 'approved' }));

      await service.runBillingCycle();

      expect(businesses.addDocCredits).not.toHaveBeenCalled();
      expect(doc.applied).toBe(false);
    });

    it('un webhook tampoco lo re-aplica', async () => {
      build(pago({ status: 'approved' }));

      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.updatePlan).not.toHaveBeenCalled();
    });

    it('la reserva marca la versión, y así el barrido sí retoma lo nuevo', async () => {
      const { doc } = build(pago());
      businesses.updatePlan.mockRejectedValueOnce(new Error('caído'));

      await expect(service.handleWebhook(evento('APPROVED'))).rejects.toThrow();
      expect(doc.applyVersion).toBe(2);

      await service.runBillingCycle();
      expect(doc.applied).toBe(true);
    });

    it('acredita los documentos con el id del pago, para que no se dupliquen', async () => {
      build(pago({ kind: 'docPackage', docPackages: 1 }));

      await service.handleWebhook(evento('APPROVED'));

      expect(businesses.addDocCredits.mock.calls[0][2]).toBe('pay1');
    });
  });

  describe('rechazo idempotente', () => {
    it('un DECLINED repetido suma un solo intento fallido', async () => {
      const { sub } = build(pago(), suscripcion({ failedAttempts: 0 }));

      await service.handleWebhook(evento('DECLINED'));
      await service.handleWebhook(evento('DECLINED'));

      expect(sub.failedAttempts).toBe(1);
    });

    it('un rechazo con una copia vieja no pisa un pago ya aprobado en la base', async () => {
      // La base ya tiene el pago aprobado; esta request leyó antes (pending).
      const base = pago({ status: 'approved', applied: true, wompiTransactionId: 'tx-1' });
      const { sub } = build(base);
      payments.findOne = vi.fn(() => ({
        exec: () =>
          Promise.resolve({
            ...base,
            status: 'pending',
            applied: false,
            save: vi.fn(function (this: any) {
              base.status = this.status;
              return Promise.resolve();
            }),
          }),
      }));

      await service.handleWebhook(evento('DECLINED'));

      expect(base.status).toBe('approved');
      expect(sub.status).toBe('active');
    });
  });

  describe('verificación también fuera del webhook', () => {
    it('la consulta del frontend no aplica si el monto no coincide', async () => {
      const { doc } = build(pago({ wompiTransactionId: 'tx-1' }));
      wompi.getTransaction.mockResolvedValueOnce({
        id: 'tx-1',
        status: 'APPROVED',
        reference: 'ref-1',
        amount_in_cents: 100,
        currency: 'COP',
      });

      await service.syncPayment(BIZ, 'ref-1');

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(doc.applied).toBe(false);
    });

    it('el barrido no aplica si la referencia no coincide', async () => {
      const { doc } = build(
        pago({ wompiTransactionId: 'tx-1', createdAt: new Date(0) }),
      );
      wompi.getTransaction.mockResolvedValueOnce({
        id: 'tx-1',
        status: 'APPROVED',
        reference: 'otra-ref',
        amount_in_cents: 9_900_000,
        currency: 'COP',
      });

      await service.runBillingCycle();

      expect(businesses.updatePlan).not.toHaveBeenCalled();
      expect(doc.applied).toBe(false);
    });
  });

  describe('barrido de pendientes', () => {
    it('consulta primero los que hace más tiempo no se revisan', async () => {
      build(pago({ wompiTransactionId: 'tx-1', createdAt: new Date(0) }));
      estadoReal = 'PENDING';

      await service.runBillingCycle();

      expect(ordenes).toContainEqual({ lastReconcileAt: 1, createdAt: 1 });
    });

    it('anota la consulta aunque siga pendiente, para rotar el cupo', async () => {
      const { doc } = build(pago({ wompiTransactionId: 'tx-1', createdAt: new Date(0) }));
      estadoReal = 'PENDING';

      await service.runBillingCycle();

      expect(doc.lastReconcileAt).toBeInstanceOf(Date);
    });
  });
});
