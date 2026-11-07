import { describe, it, expect, vi } from 'vitest';

// Patrón de `orders.service.checkout.spec.ts`: neutraliza los decoradores.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { EinvoicingService } from './einvoicing.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** `GET /einvoicing/resolutions` expone el corte guardado del talonario, solo en la de contingencia. */
describe('EinvoicingService · resolutionStatus', () => {
  const user = { email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;
  const hasta = new Date(Date.now() + 90 * 86_400_000);

  function montar(sede: Record<string, unknown>) {
    const counters = { findById: vi.fn(() => ({ exec: async () => null })) };
    const sedes = { list: vi.fn(async () => [{ id: 's1', code: 'S1', name: 'Sede', ...sede }]) };
    return new EinvoicingService({} as any, counters as any, {} as any, sedes as any, {} as any, {} as any);
  }

  it('la resolución de contingencia trae el corteTalonario guardado', async () => {
    const svc = montar({
      resolucionFe: { prefijo: 'FE', rangoDesde: 1, rangoHasta: 1000, vigenciaHasta: hasta },
      resolucionesFe: [
        { tipoDocumento: 'contingency', prefijo: 'CT', rangoDesde: 1, rangoHasta: 100, corteTalonario: 40, vigenciaHasta: hasta },
      ],
    });
    const [fila] = await svc.resolutionStatus(user);
    expect(fila!.otras[0]!.resolucion.corteTalonario).toBe(40);
    expect(fila!.resolucion).not.toHaveProperty('corteTalonario');
  });

  it('sin corte guardado el campo no aparece', async () => {
    const svc = montar({
      resolucionesFe: [{ tipoDocumento: 'contingency', prefijo: 'CT', rangoDesde: 1, rangoHasta: 100, vigenciaHasta: hasta }],
    });
    const [fila] = await svc.resolutionStatus(user);
    expect(fila!.otras[0]!.resolucion).not.toHaveProperty('corteTalonario');
  });
});
