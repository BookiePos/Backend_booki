import { describe, expect, it } from 'vitest';
import { saleTaxFor, INC_RESTAURANTE_CODE } from '../../core-tax/domain/sale-tax';
import { cop } from '../../finance/domain/money.util';
import { PLANTILLAS, TIPOS_PLANTILLA, fiscalDe, itemsDe, plantillaDe } from './plantillas';

describe('plantillas de arranque', () => {
  it('hay una plantilla por cada tipo declarado, sin repetir prefijo', () => {
    expect(PLANTILLAS.map((p) => p.tipo).sort()).toEqual([...TIPOS_PLANTILLA].sort());
    expect(new Set(PLANTILLAS.map((p) => p.prefijo)).size).toBe(PLANTILLAS.length);
  });

  it('los SKU son únicos entre TODAS las plantillas y estables (PL-<prefijo>-NN)', () => {
    const skus = PLANTILLAS.flatMap((p) => itemsDe(p).map((i) => i.sku));
    expect(new Set(skus).size).toBe(skus.length);
    expect(skus.every((s) => /^PL-[A-Z]+-\d{2}$/.test(s))).toBe(true);
    expect(itemsDe(plantillaDe('restaurante')!)[0]!.sku).toBe('PL-REST-01');
  });

  it('precios y costos son pesos enteros positivos y el costo no supera el precio', () => {
    for (const p of PLANTILLAS) {
      for (const i of itemsDe(p)) {
        expect(Number.isInteger(i.precio), `${i.sku} precio`).toBe(true);
        expect(Number.isInteger(i.costo), `${i.sku} costo`).toBe(true);
        expect(cop(i.precio)).toBe(i.precio);
        expect(i.costo).toBeGreaterThan(0);
        expect(i.costo).toBeLessThan(i.precio);
      }
    }
  });

  it('no repite nombre dentro de una plantilla', () => {
    for (const p of PLANTILLAS) {
      const nombres = itemsDe(p).map((i) => i.nombre);
      expect(new Set(nombres).size, p.tipo).toBe(nombres.length);
    }
  });

  it('solo restaurante y cafetería traen mesas', () => {
    expect(PLANTILLAS.filter((p) => p.mesas).map((p) => p.tipo).sort()).toEqual([
      'cafeteria',
      'restaurante',
    ]);
  });
});

describe('impuesto de cada ítem según el giro', () => {
  const servido = itemsDe(plantillaDe('restaurante')!).find((i) => i.nombre === 'Bandeja paisa')!;
  const gaseosa = itemsDe(plantillaDe('restaurante')!).find((i) => i.nombre === 'Gaseosa 400 ml')!;
  const arroz = itemsDe(plantillaDe('tienda')!).find((i) => i.nombre === 'Arroz 1 kg')!;
  const cafe = itemsDe(plantillaDe('tienda')!).find((i) => i.nombre === 'Café molido 250 g')!;
  const detergente = itemsDe(plantillaDe('tienda')!).find((i) => i.nombre === 'Detergente 1 kg')!;

  it('restaurante: lo servido es expendio sin IVA y la venta le cobra INC', () => {
    const f = fiscalDe(servido, 'restaurante');
    expect(f).toMatchObject({ ivaRate: 0, ivaType: 'excluido', tratamientoFiscal: 'expendio', efecto: 'inc' });
    const venta = saleTaxFor(
      { tipoNegocio: 'restaurante' },
      { ivaType: f.ivaType, ivaRate: f.ivaRate, tratamiento: f.tratamientoFiscal },
      8,
    );
    expect(venta).toEqual({ kind: 'inc', rate: 8 });
    expect(INC_RESTAURANTE_CODE).toBe('INC_8');
  });

  it('restaurante: la gaseosa empacada es mercancía y lleva el IVA del bien, no INC', () => {
    const f = fiscalDe(gaseosa, 'restaurante');
    expect(f).toMatchObject({ ivaRate: 19, ivaType: 'gravado', tratamientoFiscal: 'mercancia', efecto: 'iva' });
    expect(
      saleTaxFor(
        { tipoNegocio: 'restaurante' },
        { ivaType: f.ivaType, ivaRate: f.ivaRate, tratamiento: f.tratamientoFiscal },
        8,
      ),
    ).toEqual({ kind: 'iva', rate: 19 });
  });

  it('restaurante que no es responsable de INC: lo servido no discrimina impuesto', () => {
    const f = fiscalDe(servido, 'restaurante');
    expect(
      saleTaxFor(
        { tipoNegocio: 'restaurante', responsableInc: false },
        { ivaType: f.ivaType, ivaRate: f.ivaRate, tratamiento: f.tratamientoFiscal },
        8,
      ),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('retail: cada bien con su tarifa (excluido 0, reducido 5, general 19) y sin tratamiento', () => {
    const tarifa = (i: typeof arroz) => {
      const f = fiscalDe(i, 'retail');
      expect(f.tratamientoFiscal).toBeUndefined();
      return saleTaxFor({ tipoNegocio: 'retail' }, { ivaType: f.ivaType, ivaRate: f.ivaRate }, 8);
    };
    expect(tarifa(arroz)).toEqual({ kind: 'iva', rate: 0 });
    expect(tarifa(cafe)).toEqual({ kind: 'iva', rate: 5 });
    expect(tarifa(detergente)).toEqual({ kind: 'iva', rate: 19 });
  });

  it('retail: lo "servido" de una plantilla de comida no se vuelve INC', () => {
    const f = fiscalDe(servido, 'retail');
    expect(f).toMatchObject({ ivaRate: 19, ivaType: 'gravado', efecto: 'iva' });
  });

  it('toda combinación tipo de plantilla x giro da una tarifa válida (0/5/19) y coherente', () => {
    for (const p of PLANTILLAS) {
      for (const giro of ['restaurante', 'retail'] as const) {
        for (const i of itemsDe(p)) {
          const f = fiscalDe(i, giro);
          expect([0, 5, 19]).toContain(f.ivaRate);
          if (f.ivaType !== 'gravado') expect(f.ivaRate).toBe(0);
        }
      }
    }
  });
});
