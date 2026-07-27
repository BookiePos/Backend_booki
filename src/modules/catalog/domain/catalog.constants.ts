/**
 * Constantes de dominio del catálogo de productos vendibles (POS).
 *
 * Un producto vendible se abastece de una de dos formas:
 * - inventory: vinculado directamente a un ítem de inventario; cada unidad
 *   vendida descuenta `qtyPerUnit` de ese ítem.
 * - recipe: se arma con una receta (ingredientes + cantidades); cada unidad
 *   vendida descuenta cada ingrediente según su cantidad.
 */
export const CATALOG_SOURCE_TYPES = ['inventory', 'recipe'] as const;

export type CatalogSourceType = (typeof CATALOG_SOURCE_TYPES)[number];

/**
 * IVA del producto (factura electrónica). El precio de venta YA incluye el IVA;
 * en la factura se discrimina la base hacia atrás. Tarifas vigentes en Colombia:
 * 19% (general), 5% (reducida), 0% (exento — con derecho a base gravable).
 */
export const IVA_RATES = [0, 5, 19] as const;
export type IvaRate = (typeof IVA_RATES)[number];

/**
 * Tratamiento de IVA: 'gravado' (5/19), 'exento' (0% pero base reportable) o
 * 'excluido' (no causa IVA). 'exento'/'excluido' implican tarifa 0.
 */
export const IVA_TYPES = ['gravado', 'exento', 'excluido'] as const;
export type IvaType = (typeof IVA_TYPES)[number];
