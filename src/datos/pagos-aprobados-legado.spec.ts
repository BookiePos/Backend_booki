import { describe, it, expect } from 'vitest';
import {
  FILTRO_PAGOS_LEGADO,
  contarLegado,
  type PagoLegado,
} from './pagos-aprobados-legado';

function pago(over: Partial<PagoLegado> = {}): PagoLegado {
  return {
    id: 'p1',
    reference: 'doc-biz-1',
    kind: 'docPackage',
    amountInCents: 5_000_000,
    ...over,
  };
}

describe('pagos aprobados por el código anterior', () => {
  it('el filtro toma solo aprobados sin aplicar y sin marca de versión', () => {
    expect(FILTRO_PAGOS_LEGADO).toEqual({
      status: 'approved',
      applied: { $ne: true },
      applyVersion: { $exists: false },
    });
  });

  it('cuenta por tipo y suma el monto en pesos', () => {
    const c = contarLegado([
      pago(),
      pago({ id: 'p2', kind: 'renewal', amountInCents: 9_900_000 }),
      pago({ id: 'p3', kind: 'subscription', amountInCents: 100_050 }),
    ]);

    expect(c).toEqual({
      pagos: 3,
      docPackage: 1,
      subscription: 1,
      renewal: 1,
      // 50.000 + 99.000 + 1.000,5 → redondeado a peso.
      montoCop: 150_001,
    });
  });

  it('sin pagos todo en cero', () => {
    expect(contarLegado([])).toEqual({
      pagos: 0,
      docPackage: 0,
      subscription: 0,
      renewal: 0,
      montoCop: 0,
    });
  });
});
