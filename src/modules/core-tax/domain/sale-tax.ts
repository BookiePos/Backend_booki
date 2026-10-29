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

/**
 * Lo que importa del negocio para decidir el impuesto. Las responsabilidades
 * del RUT (ítem 1.17) son opcionales: si no se diligencian se infieren del
 * giro y de `responsabilidadFiscal`, que es el comportamiento anterior.
 */
export interface SaleTaxProfile {
  tipoNegocio?: BusinessType;
  responsabilidadFiscal?: ResponsabilidadFiscal;
  /** Responsable de IVA (RUT 48) o no (RUT 49, art. 437 par. 3 ET). */
  responsableIva?: boolean;
  /**
   * Responsable de INC (responsabilidad 33 del RUT) o no (art. 512-13 ET).
   * Confirmar en el RUT del negocio.
   */
  responsableInc?: boolean;
  /** Expendio de comidas bajo franquicia: IVA, no INC (art. 426 par. ET). */
  franquicia?: boolean;
}

/**
 * Tratamiento que trae el producto del catálogo. `tratamiento` distingue, en
 * un restaurante, lo que se sirve (expendio, con INC) de la mercancía que se
 * revende sin servicio (leche, huevos, gaseosa para llevar), que lleva el IVA
 * del bien. Sin dato, en un restaurante se toma como expendio.
 */
export interface ProductTax {
  ivaType: string;
  ivaRate: number;
  tratamiento?: 'expendio' | 'mercancia';
}

/** Expendio de comidas y bebidas que no es franquicia (arts. 426 y 512-1 ET). */
function esExpendio(profile: SaleTaxProfile): boolean {
  return profile.tipoNegocio === 'restaurante' && profile.franquicia !== true;
}

/** Si es responsable de IVA. Sin dato, todo salvo `no_responsable_iva`. */
function responsableIva(profile: SaleTaxProfile): boolean {
  return profile.responsableIva ?? profile.responsabilidadFiscal !== 'no_responsable_iva';
}

/** Si el negocio puede causar INC: solo entonces hace falta su tarifa. */
export function causesInc(profile: SaleTaxProfile): boolean {
  return esExpendio(profile) && profile.responsableInc !== false;
}

/**
 * Decide el impuesto de una línea.
 *
 * 1. Expendio de comidas y bebidas que no es franquicia (restaurante, bar,
 *    cafetería) → lo que se sirve es excluido de IVA y gravado con INC (arts.
 *    426, 512-1 num. 3 y 512-9 ET), aunque el producto diga "gravado 19 %".
 *    - Si el negocio no es responsable de INC (art. 512-13: persona natural,
 *      un solo establecimiento, ingresos < 3.500 UVT), no lleva impuesto.
 *    - SIMPLE: el INC no se integra a la tarifa consolidada; se causa aparte y
 *      se declara y paga a través del SIMPLE (art. 915 ET).
 *    - Sin dato de responsabilidad de INC se causa (lectura conservadora).
 *
 * 2. Franquicia (art. 426 par. ET, Oficio DIAN 1283/2020), retail y mercancía
 *    revendida sin servicio en un restaurante → régimen de IVA del bien: si el
 *    negocio no es responsable de IVA (art. 437 par. 3 ET, incluidos los del
 *    SIMPLE que cumplen sus requisitos) no discrimina impuesto; si lo es,
 *    IVA a la tarifa del producto.
 *
 * Pendiente: el negocio mixto prorratea el IVA descontable (art. 490 ET).
 */
export function saleTaxFor(
  profile: SaleTaxProfile,
  product: ProductTax,
  incRate: number,
): { kind: SaleTaxKind; rate: number } {
  // Lo que se sirve en un restaurante (no franquicia) es excluido de IVA y
  // gravado con INC; si el negocio no es responsable de INC, no lleva nada.
  if (esExpendio(profile) && product.tratamiento !== 'mercancia') {
    return causesInc(profile)
      ? { kind: 'inc', rate: incRate }
      : { kind: 'ninguno', rate: 0 };
  }
  // Retail, franquicias y mercancía revendida: régimen de IVA del bien.
  if (!responsableIva(profile)) {
    return { kind: 'ninguno', rate: 0 };
  }
  return {
    kind: 'iva',
    rate: product.ivaType === 'gravado' ? product.ivaRate : 0,
  };
}

/**
 * Impuesto del cobro de domicilio que hace el propio restaurante.
 *
 * La base del INC es el «precio total de consumo… y demás valores
 * adicionales», sin desagregar salvo la propina (arts. 512-1 num. 3 y 512-9
 * ET), y el valor del domicilio es un valor adicional del expendio (Oficio
 * DIAN 664 (904106) de 2022). La exclusión de IVA del transporte (art. 476)
 * no aplica al INC. Así que el domicilio lleva el mismo tratamiento que la
 * comida: INC en el régimen normal, IVA 19 % en la franquicia (art. 447: el
 * valor total de la operación) y nada si el negocio no es responsable.
 *
 * Fuera de un restaurante (retail) el domicilio sigue sin impuesto, como
 * antes: ahí el bien vendido puede ser excluido o de varias tarifas y no hay
 * una «comida» de la que heredar el tratamiento. Pendiente del contador.
 */
export function deliveryTaxFor(
  profile: SaleTaxProfile,
  incRate: number,
): { kind: SaleTaxKind; rate: number } {
  if (profile.tipoNegocio !== 'restaurante') return { kind: 'ninguno', rate: 0 };
  return saleTaxFor(
    profile,
    { ivaType: 'gravado', ivaRate: 19, tratamiento: 'expendio' },
    incRate,
  );
}

/** Lo que mira el aviso de no responsable de INC. */
export interface PerfilNoResponsableInc {
  responsableInc?: boolean;
  franquicia?: boolean;
  tipoPersona?: 'natural' | 'juridica';
}

/**
 * Avisos cuando una sede está marcada como NO responsable de INC y eso no
 * cuadra con el art. 512-13 ET, que solo lo permite a la persona natural con
 * un solo establecimiento e ingresos menores a 3.500 UVT. Es solo un aviso:
 * la venta sigue sin INC hasta que alguien corrija el perfil, porque el dato
 * que lo decide (el RUT) no lo tiene el sistema.
 *
 * @param sedesActivas sedes activas de la empresa (establecimientos).
 */
export function advertenciasNoResponsableInc(
  sede: PerfilNoResponsableInc,
  sedesActivas: number,
): string[] {
  if (sede.responsableInc !== false || sede.franquicia === true) return [];
  const norma =
    'El art. 512-13 ET solo permite no ser responsable de INC a una persona natural, con un ' +
    'solo establecimiento e ingresos brutos menores a 3.500 UVT. Confirmar en el RUT.';
  const avisos: string[] = [];
  if (sede.tipoPersona === 'juridica') {
    avisos.push(
      `La sede está marcada como no responsable de INC, pero es persona jurídica. ${norma}`,
    );
  }
  if (sedesActivas > 1) {
    avisos.push(
      `La sede está marcada como no responsable de INC, pero la empresa tiene ${sedesActivas} ` +
        `sedes. ${norma}`,
    );
  }
  return avisos;
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
 * Pendiente: el negocio mixto (restaurante que además vende mercancía
 * gravada) prorratea el IVA descontable (art. 490 ET); hoy decide el giro.
 */
export function admiteIvaDescontable(profile: SaleTaxProfile): boolean {
  return saleTaxFor(profile, { ivaType: 'gravado', ivaRate: 19 }, 0).kind === 'iva';
}
