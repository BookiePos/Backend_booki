import type { BusinessType } from '../../control/domain/control.constants';
import type { ResponsabilidadFiscal } from '../../sedes/domain/sede.constants';

/**
 * Qué impuesto lleva una línea de venta según el perfil fiscal del negocio.
 *
 * - `iva`: IVA a la tarifa del producto (0/5/19), cuenta 2408.
 * - `inc`: impuesto nacional al consumo de restaurantes y bares, cuenta 2495.
 * - `ninguno`: el vendedor no es responsable y no discrimina impuesto.
 */
export const SALE_TAX_KINDS = ['iva', 'inc', 'ninguno'] as const;
export type SaleTaxKind = (typeof SALE_TAX_KINDS)[number];

/** Código del INC en el catálogo de impuestos (core-tax, sembrado al 8 %). */
export const INC_RESTAURANTE_CODE = 'INC_8';

/** Lo que importa del negocio para decidir el impuesto. */
export interface SaleTaxProfile {
  tipoNegocio?: BusinessType;
  responsabilidadFiscal?: ResponsabilidadFiscal;
}

/** Tratamiento de IVA que trae el producto del catálogo. */
export interface ProductTax {
  ivaType: string;
  ivaRate: number;
}

/** Si el negocio causa INC (restaurante): solo entonces hace falta su tarifa. */
export function causesInc(profile: SaleTaxProfile): boolean {
  return profile.tipoNegocio === 'restaurante';
}

/**
 * Decide el impuesto de una línea.
 *
 * 1. Restaurante → INC a la tarifa vigente del catálogo, sobre TODO lo que se
 *    sirve: el expendio de comidas y bebidas es un servicio excluido de IVA y
 *    gravado con INC (arts. 426, 512-1 num. 3 y 512-9 ET). Por eso no importa
 *    que el producto diga "gravado 19 %" o "excluido".
 *
 *    Lecturas conservadoras (ante la duda, causar el impuesto y no omitirlo):
 *    - SIMPLE: el INC de restaurantes no se integra a la tarifa consolidada;
 *      se causa aparte y se declara y paga a través del SIMPLE (art. 915 ET).
 *    - `no_responsable_iva`: ese campo habla de IVA. La no responsabilidad del
 *      INC (art. 512-13: persona natural, un solo establecimiento, ingresos
 *      < 3.500 UVT) no se registra hoy en ningún sitio, así que no se presume.
 *      Si el negocio cumple el 512-13 hace falta un campo propio para eso.
 *
 * 2. No responsable de IVA → no discrimina IVA (art. 437 par. 3 ET).
 *
 * 3. Resto (responsable, gran contribuyente, SIMPLE en retail o perfil
 *    desconocido) → IVA a la tarifa del producto, que es el comportamiento de
 *    siempre. El SIMPLE en retail es responsable de IVA (art. 915 ET), salvo
 *    las personas naturales del SIMPLE que cumplen los requisitos del art. 437
 *    par. 3 ET, que no son responsables de IVA. Ese caso no se distingue hoy
 *    (pendiente de modelar en el perfil fiscal): ante la duda se causa IVA.
 */
export function saleTaxFor(
  profile: SaleTaxProfile,
  product: ProductTax,
  incRate: number,
): { kind: SaleTaxKind; rate: number } {
  if (causesInc(profile)) {
    return { kind: 'inc', rate: incRate };
  }
  if (profile.responsabilidadFiscal === 'no_responsable_iva') {
    return { kind: 'ninguno', rate: 0 };
  }
  return {
    kind: 'iva',
    rate: product.ivaType === 'gravado' ? product.ivaRate : 0,
  };
}

/**
 * Si el IVA pagado en compras y gastos es descontable (cuenta 2408, débito) o
 * mayor valor del costo del inventario o del gasto.
 *
 * Solo descuenta IVA quien es responsable de IVA y adquiere para operaciones
 * gravadas con IVA (arts. 437 y 488 ET). Se decide con el mismo perfil que la
 * venta: si el negocio no discrimina IVA al vender —restaurante que causa INC,
 * cuya venta es excluida de IVA (art. 426 ET), o no responsable de IVA (art.
 * 437 par. 3)— no tiene contra qué descontarlo y el IVA pagado es costo.
 *
 * Pendiente (ítem 1.17): el negocio mixto (restaurante que además vende
 * mercancía gravada) prorratea el IVA descontable (art. 490 ET).
 */
export function admiteIvaDescontable(profile: SaleTaxProfile): boolean {
  return saleTaxFor(profile, { ivaType: 'gravado', ivaRate: 19 }, 0).kind === 'iva';
}
