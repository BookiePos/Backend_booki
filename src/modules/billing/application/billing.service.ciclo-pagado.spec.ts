import { describe, it, expect, vi } from 'vitest';

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
 * Ítem 4.11: el período que abre un pago aprobado sale del ciclo de ESE pago.
 * `subscribe` sobrescribe el ciclo de la suscripción antes de cobrar, así que
 * pagar un mes y pedir enseguida el anual (con un cobro que falla) abría 12
 * meses con el pago de uno.
 */
const BIZ = '68b0f3c2a1d4e5f6a7b8c9d0';
const DIA = 86_400_000;

function service(sub: any) {
  const subs = { findOne: vi.fn(() => ({ exec: () => Promise.resolve(sub) })) };
  return new BillingService(
    {} as never,
    { configured: true } as never,
    subs as never,
    {} as never,
    {} as never,
  ) as unknown as { advancePeriod(p: unknown): Promise<void> };
}

describe('BillingService · el período sale del ciclo pagado', () => {
  it('pago mensual con la suscripción ya cambiada a anual → 1 mes, no 12', async () => {
    const sub = { billingCycle: 'annual', save: vi.fn() } as any;
    await service(sub).advancePeriod({ businessId: BIZ, billingCycle: 'monthly' });
    const dias = (sub.currentPeriodEnd.getTime() - Date.now()) / DIA;
    expect(dias).toBeGreaterThan(27);
    expect(dias).toBeLessThan(32);
    expect(sub.billingCycle).toBe('monthly');
    expect(sub.save).toHaveBeenCalled();
  });

  it('copia también monto, plan y complementos del pago', async () => {
    const sub = { billingCycle: 'annual', plan: 'basico', amountInCents: 1, addOns: {}, save: vi.fn() } as any;
    const addOns = { nomina: true };
    await service(sub).advancePeriod({
      businessId: BIZ,
      billingCycle: 'monthly',
      amountInCents: 9_900_000,
      plan: 'negocio',
      addOns,
    });
    expect(sub.amountInCents).toBe(9_900_000);
    expect(sub.plan).toBe('negocio');
    expect(sub.addOns).toBe(addOns);
  });

  it('un pago sin ciclo (anterior al campo) usa el de la suscripción', async () => {
    const sub = { billingCycle: 'annual', save: vi.fn() } as any;
    await service(sub).advancePeriod({ businessId: BIZ });
    const dias = (sub.currentPeriodEnd.getTime() - Date.now()) / DIA;
    expect(dias).toBeGreaterThan(360);
  });
});
