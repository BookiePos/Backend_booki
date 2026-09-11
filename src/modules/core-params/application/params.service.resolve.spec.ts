import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

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

import { ParamsService } from './params.service';

/**
 * Resolución de parámetros de configuración.
 *
 * De aquí salen cifras que el resto del sistema usa sin discutir: los días de
 * gracia del fiado, topes, porcentajes. Tienen dos dimensiones a la vez, y las
 * dos se pueden equivocar en silencio:
 *
 * - La FECHA. Un valor programado para el mes que viene no puede aplicarse hoy.
 * - La SEDE. Una sede puede tener su propio valor; si no lo tiene, hereda el
 *   global. Si la herencia fallara, la sede caería en el valor por defecto del
 *   código y nadie notaría que dejó de respetar la configuración de la empresa.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado.
 */
describe('ParamsService · resolución por fecha y sede', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';

  /** Versiones cargadas: clave, sede (null = global), valor y vigencia. */
  const VERSIONES = [
    { key: 'finanzas.dias_gracia_cxc', sedeId: null, value: 30, effectiveFrom: '2026-01-01' },
    { key: 'finanzas.dias_gracia_cxc', sedeId: null, value: 45, effectiveFrom: '2027-01-01' },
    { key: 'finanzas.dias_gracia_cxc', sedeId: SEDE, value: 15, effectiveFrom: '2026-06-01' },
    { key: 'pos.pide_cliente', sedeId: null, value: true, effectiveFrom: '2026-01-01' },
    { key: 'pos.mensaje_tiquete', sedeId: null, value: 'Gracias', effectiveFrom: '2026-01-01' },
  ];

  let params: any;
  let service: ParamsService;

  beforeEach(() => {
    params = {
      distinct: vi.fn().mockResolvedValue(VERSIONES.map((v) => v.key)),
      insertMany: vi.fn(),
      collection: { indexes: vi.fn().mockResolvedValue([]) },
      findOne: vi.fn((filter: any) => ({
        sort: () => ({
          exec: () => {
            const hasta = filter.effectiveFrom.$lte as string;
            // `$or` sobre sedeId es como el servicio pide el ámbito global.
            const global = filter.$or !== undefined;
            const candidatos = VERSIONES.filter(
              (v) =>
                v.key === filter.key &&
                v.effectiveFrom <= hasta &&
                (global ? v.sedeId === null : v.sedeId === filter.sedeId),
            ).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
            return Promise.resolve(candidatos[0] ?? null);
          },
        }),
      })),
    };
    service = new ParamsService(params as never);
  });

  describe('vigencia por fecha', () => {
    it('toma el valor vigente a la fecha pedida', async () => {
      const r = await service.resolve('finanzas.dias_gracia_cxc', {
        date: '2026-03-01',
      });

      expect(r.value).toBe(30);
      expect(r.effectiveFrom).toBe('2026-01-01');
    });

    it('un valor programado a futuro no se aplica antes de tiempo', async () => {
      const antes = await service.resolve('finanzas.dias_gracia_cxc', {
        date: '2026-12-31',
      });
      const desde = await service.resolve('finanzas.dias_gracia_cxc', {
        date: '2027-01-01',
      });

      expect(antes.value).toBe(30);
      expect(desde.value).toBe(45);
    });

    it('una clave sin ninguna vigencia aplicable falla claro', async () => {
      await expect(
        service.resolve('finanzas.dias_gracia_cxc', { date: '2025-01-01' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('herencia por sede', () => {
    it('la sede con valor propio usa el suyo, no el global', async () => {
      const r = await service.resolve('finanzas.dias_gracia_cxc', {
        date: '2026-09-01',
        sedeId: SEDE,
      });

      expect(r.value).toBe(15);
      expect(r.sedeId).toBe(SEDE);
    });

    it('antes de que arranque el valor de la sede, hereda el global', async () => {
      const r = await service.resolve('finanzas.dias_gracia_cxc', {
        date: '2026-03-01',
        sedeId: SEDE,
      });

      expect(r.value).toBe(30);
      expect(r.sedeId).toBeNull();
    });

    it('una sede sin valor propio hereda el global', async () => {
      const otraSede = '000000000000000000000000';

      const r = await service.resolve('finanzas.dias_gracia_cxc', {
        date: '2026-09-01',
        sedeId: otraSede,
      });

      expect(r.value).toBe(30);
      expect(r.sedeId).toBeNull();
    });

    it('sin sede solo mira el ámbito global, nunca el de una sede', async () => {
      const r = await service.resolve('finanzas.dias_gracia_cxc', {
        date: '2026-09-01',
      });

      expect(r.value).toBe(30);
    });
  });

  describe('lectores con valor por defecto', () => {
    it('devuelven el configurado cuando existe', async () => {
      const n = await service.number('finanzas.dias_gracia_cxc', 99, {
        date: '2026-03-01',
      });
      const b = await service.bool('pos.pide_cliente', false, {
        date: '2026-03-01',
      });
      const t = await service.text('pos.mensaje_tiquete', 'nada', {
        date: '2026-03-01',
      });

      expect(n).toBe(30);
      expect(b).toBe(true);
      expect(t).toBe('Gracias');
    });

    it('una clave inexistente cae al valor por defecto, no revienta', async () => {
      const n = await service.number('clave.que.no.existe', 7);
      const b = await service.bool('clave.que.no.existe', true);
      const t = await service.text('clave.que.no.existe', 'defecto');

      expect(n).toBe(7);
      expect(b).toBe(true);
      expect(t).toBe('defecto');
    });

    it('un valor del tipo equivocado cae al por defecto en vez de propagarse', async () => {
      // Protege contra un parámetro mal cargado: un texto donde se espera un
      // número no puede entrar a un cálculo de dinero.
      const n = await service.number('pos.mensaje_tiquete', 7, {
        date: '2026-03-01',
      });
      const b = await service.bool('finanzas.dias_gracia_cxc', false, {
        date: '2026-03-01',
      });

      expect(n).toBe(7);
      expect(b).toBe(false);
    });

    it('un texto vacío cuenta como ausente y cae al por defecto', async () => {
      VERSIONES.push({
        key: 'pos.vacio',
        sedeId: null,
        value: '' as never,
        effectiveFrom: '2026-01-01',
      });

      const t = await service.text('pos.vacio', 'defecto', {
        date: '2026-03-01',
      });

      expect(t).toBe('defecto');
      VERSIONES.pop();
    });

    it('resolveValue devuelve null en vez de lanzar', async () => {
      const v = await service.resolveValue('clave.que.no.existe');

      expect(v).toBeNull();
    });
  });
});
