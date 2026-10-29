import { describe, it, expect } from 'vitest';
import { advertenciasNoResponsableInc, deliveryTaxFor } from './sale-tax';

/**
 * El domicilio lleva el mismo impuesto que la comida (arts. 512-1 num. 3 y
 * 512-9 ET, Oficio DIAN 664 (904106) de 2022); fuera de un restaurante sigue
 * sin impuesto.
 */
describe('deliveryTaxFor · impuesto del domicilio', () => {
  it('restaurante en el régimen normal: INC a la tarifa vigente', () => {
    expect(deliveryTaxFor({ tipoNegocio: 'restaurante' }, 8)).toEqual({ kind: 'inc', rate: 8 });
  });

  it('franquicia responsable de IVA: IVA 19 % (art. 447)', () => {
    expect(
      deliveryTaxFor({ tipoNegocio: 'restaurante', franquicia: true, responsableIva: true }, 0),
    ).toEqual({ kind: 'iva', rate: 19 });
  });

  it('franquicia no responsable de IVA: sin impuesto', () => {
    expect(
      deliveryTaxFor({ tipoNegocio: 'restaurante', franquicia: true, responsableIva: false }, 0),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('no responsable de INC: sin impuesto', () => {
    expect(
      deliveryTaxFor({ tipoNegocio: 'restaurante', responsableInc: false }, 8),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('retail o giro desconocido: sin impuesto, como antes', () => {
    expect(deliveryTaxFor({ tipoNegocio: 'retail' }, 8)).toEqual({ kind: 'ninguno', rate: 0 });
    expect(deliveryTaxFor({}, 8)).toEqual({ kind: 'ninguno', rate: 0 });
  });
});

/** Art. 512-13 ET: el aviso no cambia la venta, solo la señala. */
describe('advertenciasNoResponsableInc', () => {
  it('persona jurídica marcada no responsable: avisa y cita la norma', () => {
    const a = advertenciasNoResponsableInc({ responsableInc: false, tipoPersona: 'juridica' }, 1);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('persona jurídica');
    expect(a[0]).toContain('512-13');
    expect(a[0]).toContain('3.500 UVT');
  });

  it('empresa con varias sedes: avisa', () => {
    const a = advertenciasNoResponsableInc({ responsableInc: false, tipoPersona: 'natural' }, 3);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('3 sedes');
  });

  it('jurídica y con varias sedes: los dos avisos', () => {
    expect(
      advertenciasNoResponsableInc({ responsableInc: false, tipoPersona: 'juridica' }, 2),
    ).toHaveLength(2);
  });

  it('persona natural con una sede, responsable, sin dato o franquicia: sin aviso', () => {
    expect(advertenciasNoResponsableInc({ responsableInc: false, tipoPersona: 'natural' }, 1)).toEqual([]);
    expect(advertenciasNoResponsableInc({ responsableInc: true, tipoPersona: 'juridica' }, 4)).toEqual([]);
    expect(advertenciasNoResponsableInc({ tipoPersona: 'juridica' }, 4)).toEqual([]);
    expect(
      advertenciasNoResponsableInc({ responsableInc: false, franquicia: true, tipoPersona: 'juridica' }, 4),
    ).toEqual([]);
  });
});
