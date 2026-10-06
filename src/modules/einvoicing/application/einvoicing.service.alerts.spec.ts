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

import { EinvoicingService } from './einvoicing.service';

/**
 * Alertas de facturación electrónica. Lo que más importa: que un certificado
 * vencido o por vencer se vea con tiempo (sin certificado no se factura), y que
 * las facturas rechazadas no se queden olvidadas.
 *
 * Constructor: (model, counters, sales, sedes, businesses, accounts).
 */
describe('EinvoicingService.alerts', () => {
  const hoy = new Date('2026-10-06T12:00:00Z');
  const user = { email: 'x', sedeIds: ['64b000000000000000000001'], permissions: [] } as any;

  function build(opts: {
    vence?: Date;
    pendientes?: number;
    rechazados?: number;
  }) {
    const countDocuments = vi.fn((q: any) => ({
      exec: () =>
        Promise.resolve(
          q.dianStatus === 'pending' ? (opts.pendientes ?? 0) : (opts.rechazados ?? 0),
        ),
    }));
    const service = new EinvoicingService(
      { countDocuments } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        list: vi.fn().mockResolvedValue([
          { nit: '900123456', certificateExpiresAt: opts.vence },
        ]),
      } as never,
    );
    return { service, countDocuments };
  }

  /** Vence dentro de `d` días, unas horas antes del día completo. */
  const enDias = (d: number) => new Date(hoy.getTime() + d * 24 * 3600 * 1000 - 3600 * 1000);

  it('sin novedades no hay alertas', async () => {
    const { service } = build({ vence: enDias(200) });

    expect(await service.alerts(user, hoy)).toEqual([]);
  });

  it('certificado que vence en 30 días: aviso', async () => {
    const { service } = build({ vence: enDias(30) });

    const [a] = await service.alerts(user, hoy);

    expect(a).toMatchObject({ kind: 'certificate', severity: 'warning', nit: '900123456' });
    expect(a?.message).toMatch(/vence en 30 día/);
  });

  it('certificado que vence en 10 días: urgente', async () => {
    const { service } = build({ vence: enDias(10) });

    expect((await service.alerts(user, hoy))[0]?.severity).toBe('danger');
  });

  it('certificado vencido: urgente y lo dice', async () => {
    const { service } = build({ vence: enDias(-3) });

    const [a] = await service.alerts(user, hoy);

    expect(a?.severity).toBe('danger');
    expect(a?.message).toMatch(/venció hace 3 día/);
  });

  it('cuenta rechazadas y pendientes viejas, lo grave primero', async () => {
    const { service } = build({ pendientes: 2, rechazados: 1 });

    const alertas = await service.alerts(user, hoy);

    expect(alertas.map((a) => [a.kind, a.count])).toEqual([
      ['rejected', 1],
      ['pending', 2],
    ]);
  });

  it('solo mira las sedes del usuario y las pendientes de más de 2 horas', async () => {
    const { service, countDocuments } = build({});

    await service.alerts(user, hoy);

    const q = countDocuments.mock.calls.find((c: any[]) => c[0].dianStatus === 'pending')?.[0];
    expect(q.sedeId.$in.map(String)).toEqual(['64b000000000000000000001']);
    expect(q.createdAt.$lt.getTime()).toBe(hoy.getTime() - 2 * 3600 * 1000);
  });
});
