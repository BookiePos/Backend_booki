/**
 * Cuándo la ficha de un producto nuevo, creada desde una factura, está lista
 * para crear el producto. Dominio puro.
 *
 * Un producto mal creado se queda en el catálogo: un SKU inventado, una unidad
 * equivocada o un costo leído con los separadores cambiados se arrastran a cada
 * compra, receta y venta. Por eso no basta con "lo que la foto alcanzó a leer":
 * la persona completa lo que falta y confirma, uno por uno, los datos leídos.
 */

export interface NewProductFields {
  sku?: string;
  name?: string;
  unit?: string;
  categoryId?: unknown;
  cost?: number;
  salePrice?: number;
  minStock?: number;
  itemType?: string;
  /** No se vende en el POS: no necesita precio de venta. */
  notSold?: boolean;
  /** La persona revisó contra la factura los datos que venían prellenados. */
  reviewed?: boolean;
}

/**
 * Lo que le falta a la ficha, en palabras que se le pueden mostrar a la
 * persona. Vacío = se puede crear el producto.
 */
export function newProductMissing(draft?: NewProductFields | null): string[] {
  const ficha = draft ?? {};
  const missing: string[] = [];

  if (!ficha.itemType) missing.push('el tipo (Producto o Montaje)');
  if (!ficha.sku?.trim()) missing.push('el SKU');
  if (!ficha.name?.trim()) missing.push('el nombre');
  if (!ficha.unit?.trim()) missing.push('la unidad');
  if (!ficha.categoryId) missing.push('la categoría');
  if (!(typeof ficha.cost === 'number' && ficha.cost > 0)) {
    missing.push('el costo de compra');
  }
  if (typeof ficha.minStock !== 'number' || !Number.isFinite(ficha.minStock)) {
    missing.push('el stock mínimo');
  }
  if (!ficha.notSold && !(typeof ficha.salePrice === 'number' && ficha.salePrice > 0)) {
    missing.push('el precio de venta (o marcar que no se vende en el POS)');
  }
  if (!ficha.reviewed) {
    missing.push('confirmar los datos que se leyeron de la factura');
  }
  return missing;
}
