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

import { TaxService } from './tax.service';

/**
 * Las tarifas de impuesto son VERSIONADAS por fecha: una reforma se carga con
 * antelación y solo debe aplicar desde el día que arranca.
 *
 * Es la clase de error que no se nota: si una tarifa futura se aplicara antes de
 * tiempo, o una vieja siguiera aplicándose después, cada factura saldría con un
 * IVA equivocado y nadie lo vería hasta la declaración.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado. El doble de
 * `findOne` imita lo que hace Mongo: filtra por `effectiveFrom <= fecha` y se
 * queda con la vigencia más reciente.
 */
describe('TaxService · tarifas vigentes', () => {
  /** Vigencias cargadas, de la más nueva a la más vieja. */
  const VERSIONES = [
    { code: 'IVA', kind: 'iva', rate: 21, effectiveFrom: '2027-01-01' },
    { code: 'IVA', kind: 'iva', rate: 19, effectiveFrom: '2026-01-01' },
    { code: 'IVA', kind: 'iva', rate: 16, effectiveFrom: '2020-01-01' },
  ];

  let taxes: any;
  let service: TaxService;

  beforeEach(() => {
    taxes = {
      countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(1) })),
      insertMany: vi.fn(),
      findOne: vi.fn((filter: any) => ({
        sort: () => ({
          exec: () => {
            const hasta = filter.effectiveFrom?.$lte as string;
            const vigente = VERSIONES.filter(
              (v) => v.code === filter.code && v.effectiveFrom <= hasta,
            )
              // Más reciente primero: es el orden que pide el servicio.
              .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
            return Promise.resolve(vigente ?? null);
          },
        }),
      })),
    };
    service = new TaxService(taxes as never);
  });

  it('aplica la tarifa vigente a la fecha, no la más nueva cargada', async () => {
    const r = await service.compute('IVA', 100_000, '2026-06-15');

    expect(r.rate).toBe(19);
    expect(r.taxAmount).toBe(19_000);
    expect(r.total).toBe(119_000);
  });

  it('una reforma cargada por adelantado no se cobra antes de su fecha', async () => {
    const antes = await service.compute('IVA', 100_000, '2026-12-31');
    const desde = await service.compute('IVA', 100_000, '2027-01-01');

    expect(antes.rate).toBe(19);
    expect(desde.rate).toBe(21);
  });

  it('el día exacto en que arranca una vigencia ya cuenta', async () => {
    const r = await service.compute('IVA', 100_000, '2026-01-01');

    expect(r.rate).toBe(19);
  });

  it('una fecha anterior a toda vigencia no inventa tarifa: falla claro', async () => {
    await expect(service.compute('IVA', 100_000, '2019-12-31')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('acepta el código en minúsculas', async () => {
    const r = await service.compute('iva', 100_000, '2026-06-15');

    expect(r.rate).toBe(19);
  });

  describe('aritmética', () => {
    it('redondea el impuesto a peso entero', async () => {
      // 17.849 × 19% = 3.391,31 → 3.391.
      const r = await service.compute('IVA', 17_849, '2026-06-15');

      expect(r.taxAmount).toBe(3_391);
      expect(r.total).toBe(21_240);
    });

    it('el total siempre es base más impuesto, sin residuos', async () => {
      for (const base of [1, 7, 999, 17_849, 1_234_567]) {
        const r = await service.compute('IVA', base, '2026-06-15');
        expect(r.total).toBe(r.base + r.taxAmount);
        expect(Number.isInteger(r.taxAmount)).toBe(true);
      }
    });

    it('una base negativa no genera impuesto negativo: se lleva a cero', async () => {
      const r = await service.compute('IVA', -50_000, '2026-06-15');

      expect(r.base).toBe(0);
      expect(r.taxAmount).toBe(0);
      expect(r.total).toBe(0);
    });

    it('una base fraccionaria se redondea antes de calcular', async () => {
      const r = await service.compute('IVA', 10_000.6, '2026-06-15');

      expect(r.base).toBe(10_001);
    });
  });
});
