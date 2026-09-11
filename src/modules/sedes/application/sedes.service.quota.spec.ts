import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';

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

import { SedesService } from './sedes.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { PlanUpgradeRequiredException } from '../../control/domain/plan-upgrade.exception';
import { PLAN_QUOTAS } from '../../control/domain/plans';

/**
 * Tope de sedes por plan, aplicado al crear.
 *
 * Es donde el cupo comercial se hace cumplir de verdad. Dejarlo pasar regala una
 * sede que nadie pagó; aplicarlo de más le impide abrir local a un cliente que
 * sí compró el complemento.
 *
 * El plan llega en el contexto de empresa, que abre el middleware desde el
 * token. Cuando no hay plan en contexto —flujos previos a la autenticación, o el
 * control-plane caído— el tope NO se aplica: se prefiere dejar operar antes que
 * bloquear por una consulta que falló.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado.
 */
describe('SedesService.create · tope por plan', () => {
  const BUSINESS_ID = '68b0f3c2a1d4e5f6a7b8c9d0';

  let sedeModel: any;
  let service: SedesService;

  /** @param existentes sedes que ya tiene la empresa */
  function build(existentes: number) {
    sedeModel = {
      countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(existentes) })),
      create: vi.fn((doc: unknown) => Promise.resolve(doc)),
    };
    service = new SedesService(sedeModel as never);
  }

  /** Corre `fn` con el plan y complementos indicados en el contexto. */
  function conPlan<T>(
    plan: string | undefined,
    addOns: Record<string, unknown> | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return TenantContext.run(
      {
        businessId: BUSINESS_ID,
        dbName: `biz_${BUSINESS_ID}`,
        plan: plan as never,
        addOns: addOns as never,
      },
      fn,
    );
  }

  const nueva = { code: 'NORTE', name: 'Sede Norte' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('crea la sede cuando queda cupo en el plan', async () => {
    build(0);

    await conPlan('punto', undefined, () => service.create(nueva as never));

    expect(sedeModel.create).toHaveBeenCalledOnce();
  });

  it('bloquea al llegar al tope y pide mejorar el plan', async () => {
    build(PLAN_QUOTAS.punto.sedes);

    await expect(
      conPlan('punto', undefined, () => service.create(nueva as never)),
    ).rejects.toBeInstanceOf(PlanUpgradeRequiredException);
    expect(sedeModel.create).not.toHaveBeenCalled();
  });

  it('el complemento de sedes adicionales levanta el tope', async () => {
    build(PLAN_QUOTAS.punto.sedes);

    await conPlan('punto', { extraSedes: 1 }, () =>
      service.create(nueva as never),
    );

    expect(sedeModel.create).toHaveBeenCalledOnce();
  });

  it('el complemento no vuelve el tope infinito', async () => {
    build(PLAN_QUOTAS.punto.sedes + 1);

    await expect(
      conPlan('punto', { extraSedes: 1 }, () => service.create(nueva as never)),
    ).rejects.toBeInstanceOf(PlanUpgradeRequiredException);
  });

  it('un plan con más sedes admite más locales', async () => {
    build(PLAN_QUOTAS.punto.sedes);

    await conPlan('cadena', undefined, () => service.create(nueva as never));

    expect(sedeModel.create).toHaveBeenCalledOnce();
  });

  it('sin plan en contexto no se bloquea: mejor operar que frenar el negocio', async () => {
    // Pasa cuando el control-plane no respondió. Se deja crear.
    build(99);

    await conPlan(undefined, undefined, () => service.create(nueva as never));

    expect(sedeModel.create).toHaveBeenCalledOnce();
    expect(sedeModel.countDocuments).not.toHaveBeenCalled();
  });

  it('un código de sede repetido da un error claro, no un fallo de base', async () => {
    build(0);
    sedeModel.create.mockRejectedValue({ code: 11000 });

    await expect(
      conPlan('cadena', undefined, () => service.create(nueva as never)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un fallo distinto de duplicado se propaga tal cual', async () => {
    build(0);
    sedeModel.create.mockRejectedValue(new Error('sin conexión a la base'));

    await expect(
      conPlan('cadena', undefined, () => service.create(nueva as never)),
    ).rejects.toThrow('sin conexión a la base');
  });
});
