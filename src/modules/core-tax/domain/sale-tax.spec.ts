import { describe, it, expect } from 'vitest';
import { admiteIvaDescontable, saleTaxFor } from './sale-tax';

/**
 * Qué impuesto lleva una línea de venta según el perfil fiscal del negocio.
 *
 * El error que esto evita no se ve en caja: un plato de $30.000 registraba IVA
 * de $4.790 (19 %) cuando lo que corresponde es INC de $2.222 (8 %), y todo el
 * impuesto caía en la 2367. El cliente paga lo mismo; lo que sale mal es la
 * declaración (IVA en vez de INC) y el ingreso del negocio.
 */
describe('saleTaxFor · impuesto de la venta según el régimen', () => {
  const GRAVADO_19 = { ivaType: 'gravado', ivaRate: 19 } as const;
  const EXCLUIDO = { ivaType: 'excluido', ivaRate: 0 } as const;
  const INC = 8;

  it('restaurante responsable: INC 8 % aunque el producto diga IVA 19 % (arts. 426, 512-1, 512-9)', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'restaurante', responsabilidadFiscal: 'responsable_iva' },
        GRAVADO_19,
        INC,
      ),
    ).toEqual({ kind: 'inc', rate: 8 });
  });

  it('restaurante en el SIMPLE: sigue causando INC (lectura conservadora del art. 915)', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'restaurante', responsabilidadFiscal: 'regimen_simple' },
        GRAVADO_19,
        INC,
      ),
    ).toEqual({ kind: 'inc', rate: 8 });
  });

  it('restaurante: el INC cubre todo el servicio, también lo marcado excluido de IVA', () => {
    expect(
      saleTaxFor({ tipoNegocio: 'restaurante' }, EXCLUIDO, INC),
    ).toEqual({ kind: 'inc', rate: 8 });
  });

  it('la tarifa del INC es la vigente del catálogo, no un 8 fijo', () => {
    expect(saleTaxFor({ tipoNegocio: 'restaurante' }, GRAVADO_19, 10)).toEqual({
      kind: 'inc',
      rate: 10,
    });
  });

  it('retail responsable de IVA: la tarifa del producto', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'retail', responsabilidadFiscal: 'responsable_iva' },
        GRAVADO_19,
        INC,
      ),
    ).toEqual({ kind: 'iva', rate: 19 });
  });

  it('retail en el SIMPLE: responsable de IVA (art. 915), tarifa del producto', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'retail', responsabilidadFiscal: 'regimen_simple' },
        GRAVADO_19,
        INC,
      ),
    ).toEqual({ kind: 'iva', rate: 19 });
  });

  it('retail no responsable de IVA: no cobra IVA (art. 437 par. 3)', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'retail', responsabilidadFiscal: 'no_responsable_iva' },
        GRAVADO_19,
        INC,
      ),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('producto excluido o exento en retail: IVA 0', () => {
    expect(saleTaxFor({ tipoNegocio: 'retail' }, EXCLUIDO, INC)).toEqual({
      kind: 'iva',
      rate: 0,
    });
  });

  it('sin perfil conocido: se comporta como responsable de IVA (lo de siempre)', () => {
    expect(saleTaxFor({}, GRAVADO_19, INC)).toEqual({ kind: 'iva', rate: 19 });
  });
});

/**
 * Si el IVA pagado en compras y gastos se descuenta (2408) o es mayor valor del
 * costo. Solo lo descuenta quien es responsable de IVA y lo usa en operaciones
 * gravadas con IVA (arts. 437 y 488 ET).
 */
describe('admiteIvaDescontable · IVA de compras', () => {
  it('responsable de IVA en retail: sí', () => {
    expect(
      admiteIvaDescontable({ tipoNegocio: 'retail', responsabilidadFiscal: 'responsable_iva' }),
    ).toBe(true);
  });

  it('no responsable de IVA: no tiene IVA descontable (art. 437 par. 3)', () => {
    expect(
      admiteIvaDescontable({ tipoNegocio: 'retail', responsabilidadFiscal: 'no_responsable_iva' }),
    ).toBe(false);
  });

  it('restaurante que causa INC: su venta no es gravada con IVA, no descuenta (art. 488)', () => {
    expect(
      admiteIvaDescontable({ tipoNegocio: 'restaurante', responsabilidadFiscal: 'responsable_iva' }),
    ).toBe(false);
  });

  it('sin perfil conocido: como responsable (lo de siempre)', () => {
    expect(admiteIvaDescontable({})).toBe(true);
  });
});

/**
 * Ítem 1.17: el perfil fiscal con las responsabilidades del RUT explícitas.
 * Si no se diligencian, el comportamiento es el de antes (se infiere del giro
 * y de `responsabilidadFiscal`).
 */
describe('saleTaxFor · perfil fiscal completo (ítem 1.17)', () => {
  const GRAVADO_19 = { ivaType: 'gravado', ivaRate: 19 } as const;
  const INC = 8;

  it('franquicia de restaurante: IVA, no INC (art. 426 par. ET; Oficio DIAN 1283/2020)', () => {
    expect(
      saleTaxFor({ tipoNegocio: 'restaurante', franquicia: true, responsableIva: true }, GRAVADO_19, INC),
    ).toEqual({ kind: 'iva', rate: 19 });
  });

  it('restaurante no responsable de INC (art. 512-13): no discrimina impuesto', () => {
    expect(
      saleTaxFor({ tipoNegocio: 'restaurante', responsableInc: false }, GRAVADO_19, INC),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('mercancía revendida en un restaurante: lleva el IVA del bien, no INC', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'restaurante', responsableIva: true },
        { ...GRAVADO_19, tratamiento: 'mercancia' },
        INC,
      ),
    ).toEqual({ kind: 'iva', rate: 19 });
  });

  it('mercancía en un restaurante no responsable de IVA: sin impuesto', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'restaurante', responsableIva: false },
        { ...GRAVADO_19, tratamiento: 'mercancia' },
        INC,
      ),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('SIMPLE en retail que no es responsable de IVA (art. 437 par. 3): sin impuesto', () => {
    expect(
      saleTaxFor(
        { tipoNegocio: 'retail', responsabilidadFiscal: 'regimen_simple', responsableIva: false },
        GRAVADO_19,
        INC,
      ),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('la franquicia sí descuenta IVA; el restaurante con INC no', () => {
    expect(admiteIvaDescontable({ tipoNegocio: 'restaurante', franquicia: true })).toBe(true);
    expect(admiteIvaDescontable({ tipoNegocio: 'restaurante' })).toBe(false);
  });
});

/**
 * Ítem 6.5: con el registro corto la sede nace sin responsabilidad fiscal. La
 * venta no se rompe: se aplica el valor por defecto conservador (se causa el
 * impuesto) hasta que el dueño complete el perfil.
 */
describe('saleTaxFor · sede sin datos fiscales (registro corto, ítem 6.5)', () => {
  const GRAVADO_19 = { ivaType: 'gravado', ivaRate: 19 } as const;

  it('restaurante sin perfil: causa INC', () => {
    expect(saleTaxFor({ tipoNegocio: 'restaurante' }, GRAVADO_19, 8)).toEqual({
      kind: 'inc',
      rate: 8,
    });
  });

  it('retail sin perfil: IVA a la tarifa del producto', () => {
    expect(saleTaxFor({ tipoNegocio: 'retail' }, GRAVADO_19, 8)).toEqual({
      kind: 'iva',
      rate: 19,
    });
  });

  it('el IVA pagado en compras es descontable por defecto en retail, no en restaurante', () => {
    expect(admiteIvaDescontable({ tipoNegocio: 'retail' })).toBe(true);
    expect(admiteIvaDescontable({ tipoNegocio: 'restaurante' })).toBe(false);
  });
});
