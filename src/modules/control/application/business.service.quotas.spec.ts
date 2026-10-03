import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { BusinessService } from './business.service';
import { PLAN_QUOTAS } from '../domain/plans';
import { PlanUpgradeRequiredException } from '../domain/plan-upgrade.exception';

/**
 * Cupo de documentos electrónicos: cuántas facturas puede emitir una empresa.
 *
 * Hoy TODOS los planes son ilimitados (`documentsPerMonth: null`): la factura
 * sale en cada venta y un tope dejaría al negocio sin poder vender. Aun así se
 * lleva la cuenta del mes, que es lo que se muestra en el panel.
 *
 * El camino con tope se conserva (por si un plan vuelve a tenerlo) y se prueba
 * fijando un tope a mano: primero el cupo mensual, después los paquetes
 * comprados, y todo con `findOneAndUpdate` condicional para que dos facturas
 * simultáneas no pasen ambas por el último cupo.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado. El constructor
 * es: (businesses).
 */
describe('BusinessService · cupo de documentos electrónicos', () => {
  const BIZ = '68b0f3c2a1d4e5f6a7b8c9d0';
  /** Tope de prueba para el camino con cupo (ningún plan real lo tiene hoy). */
  const CUPO_PRUEBA = 400;

  let businesses: any;
  let service: BusinessService;

  /**
   * @param mensualDisponible  ¿queda cupo del mes?
   * @param creditoDisponible  ¿quedan créditos comprados?
   */
  function build(mensualDisponible: boolean, creditoDisponible: boolean) {
    businesses = {
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
      findOneAndUpdate: vi.fn((filter: any) => ({
        exec: () => {
          // El doble imita el filtro condicional de Mongo: solo "encuentra"
          // el documento si la condición de cupo se cumple.
          if (filter.docsThisMonth) {
            return Promise.resolve(mensualDisponible ? { _id: BIZ } : null);
          }
          if (filter.docCredits) {
            return Promise.resolve(creditoDisponible ? { _id: BIZ } : null);
          }
          return Promise.resolve(null);
        },
      })),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    service = new BusinessService(businesses as never);
  }

  /** Operaciones de `$inc` que se intentaron, en orden. */
  function incrementos(): any[] {
    return businesses.findOneAndUpdate.mock.calls.map((c: any[]) => c[1].$inc);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('planes ilimitados (todos, hoy)', () => {
    it('ningún plan tiene tope de documentos', () => {
      for (const cupo of Object.values(PLAN_QUOTAS)) {
        expect(cupo.documentsPerMonth).toBeNull();
      }
    });

    it('emitir solo suma al conteo del mes, sin condición de tope', async () => {
      build(false, false);

      await service.consumeDocument(BIZ, 'punto');

      expect(businesses.findOneAndUpdate).not.toHaveBeenCalled();
      const incs = businesses.updateOne.mock.calls.map((c: any[]) => c[1]);
      expect(incs).toContainEqual({ $inc: { docsThisMonth: 1 } });
    });

    it('nunca pide mejorar el plan ni gasta créditos comprados', async () => {
      build(false, true);

      await expect(service.consumeDocument(BIZ, 'cadena')).resolves.toBeUndefined();
      expect(incrementos()).toEqual([]);
    });
  });

  describe('camino con tope (si un plan vuelve a tenerlo)', () => {
    let original: number | null;
    beforeEach(() => {
      original = PLAN_QUOTAS.punto.documentsPerMonth;
      PLAN_QUOTAS.punto.documentsPerMonth = CUPO_PRUEBA;
    });
    afterEach(() => {
      PLAN_QUOTAS.punto.documentsPerMonth = original;
    });

    it('consume primero el cupo mensual del plan, sin tocar los créditos', async () => {
      build(true, true);

      await service.consumeDocument(BIZ, 'punto');

      expect(incrementos()).toEqual([{ docsThisMonth: 1 }]);
    });

    it('el descuento mensual va condicionado al tope del plan', async () => {
      build(true, false);

      await service.consumeDocument(BIZ, 'punto');

      const filtro = businesses.findOneAndUpdate.mock.calls[0][0];
      expect(filtro.docsThisMonth).toEqual({ $lt: CUPO_PRUEBA });
    });

    it('agotado el mes, tira de un crédito comprado', async () => {
      build(false, true);

      await service.consumeDocument(BIZ, 'punto');

      expect(incrementos()).toEqual([
        { docsThisMonth: 1 },
        { docCredits: -1, docsThisMonth: 1 },
      ]);
    });

    it('sin cupo mensual ni créditos, pide mejorar el plan', async () => {
      build(false, false);

      await expect(service.consumeDocument(BIZ, 'punto')).rejects.toBeInstanceOf(
        PlanUpgradeRequiredException,
      );
    });

    it('el mensaje de tope nombra el cupo real del plan', async () => {
      build(false, false);

      await expect(service.consumeDocument(BIZ, 'punto')).rejects.toThrow(
        String(CUPO_PRUEBA),
      );
    });
  });

  describe('reinicio mensual', () => {
    it('pone el contador a cero solo si cambió el mes', async () => {
      build(true, false);

      await service.consumeDocument(BIZ, 'punto');

      const [filtro, update] = businesses.updateOne.mock.calls[0];
      // Condicionado a que el período guardado sea distinto del actual: si ya
      // es el de este mes, la operación no encuentra nada y no borra el conteo.
      expect(filtro.docsPeriod.$ne).toMatch(/^\d{4}-\d{2}$/);
      expect(update.$set.docsThisMonth).toBe(0);
    });

    it('el período se calcula en hora de Colombia', async () => {
      build(true, false);

      await service.consumeDocument(BIZ, 'punto');

      const periodo = businesses.updateOne.mock.calls[0][0].docsPeriod.$ne;
      const esperado = new Date(Date.now() - 5 * 3600 * 1000)
        .toISOString()
        .slice(0, 7);
      expect(periodo).toBe(esperado);
    });
  });

  describe('créditos comprados', () => {
    it('suma los documentos del paquete al saldo', async () => {
      build(true, true);

      await service.addDocCredits(BIZ, 500);

      expect(businesses.updateOne).toHaveBeenCalledOnce();
      expect(businesses.updateOne.mock.calls[0][1]).toEqual({
        $inc: { docCredits: 500 },
      });
    });

    it('acreditar cero o menos no toca el saldo', async () => {
      build(true, true);

      await service.addDocCredits(BIZ, 0);
      await service.addDocCredits(BIZ, -10);

      expect(businesses.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('lecturas de factura por foto', () => {
    it('llevan contador propio: escanear no gasta documentos electrónicos', async () => {
      businesses = {
        updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
        findOneAndUpdate: vi.fn(() => ({
          exec: () => Promise.resolve({ _id: BIZ }),
        })),
        findById: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
      };
      service = new BusinessService(businesses as never);

      await service.consumeScan(BIZ, 'punto');

      expect(businesses.findOneAndUpdate.mock.calls[0][1].$inc).toEqual({
        scansThisMonth: 1,
      });
      expect(businesses.updateOne.mock.calls[0][1].$set).toHaveProperty(
        'scansThisMonth',
      );
    });

    it('agotado el mes no hay créditos que valgan: se mejora el plan', async () => {
      businesses = {
        updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
        findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
        findById: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
      };
      service = new BusinessService(businesses as never);

      await expect(service.consumeScan(BIZ, 'punto')).rejects.toBeInstanceOf(
        PlanUpgradeRequiredException,
      );
      // Un solo intento: no existe el respaldo de créditos comprados.
      expect(businesses.findOneAndUpdate).toHaveBeenCalledOnce();
    });
  });

  describe('uso informado en el panel', () => {
    it('un período viejo se muestra como consumo cero, no como el del mes pasado', async () => {
      businesses = {
        updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
        findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
        findById: vi.fn(() => ({
          exec: () =>
            Promise.resolve({
              plan: 'punto',
              docsPeriod: '2020-01',
              docsThisMonth: 380,
              docCredits: 100,
            }),
        })),
      };
      service = new BusinessService(businesses as never);

      const uso = await service.documentUsage(BIZ);

      expect(uso.used).toBe(0);
      // Ilimitado: el panel muestra el uso sin tope.
      expect(uso.base).toBeNull();
      expect(uso.credits).toBe(100);
    });

    it('el consumo del mes en curso sí se reporta', async () => {
      const periodo = new Date(Date.now() - 5 * 3600 * 1000)
        .toISOString()
        .slice(0, 7);
      businesses = {
        updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
        findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
        findById: vi.fn(() => ({
          exec: () =>
            Promise.resolve({
              plan: 'punto',
              docsPeriod: periodo,
              docsThisMonth: 380,
              docCredits: 0,
            }),
        })),
      };
      service = new BusinessService(businesses as never);

      const uso = await service.documentUsage(BIZ);

      expect(uso.used).toBe(380);
      expect(uso.period).toBe(periodo);
    });
  });
});
