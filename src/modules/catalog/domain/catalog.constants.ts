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
