/**
 * Reglas para fusionar productos duplicados. Dominio puro.
 */

/** Formas de escribir la misma unidad de medida. */
const UNIT_ALIASES: Record<string, string> = {
  u: 'und',
  un: 'und',
  und: 'und',
  unidad: 'und',
  unidades: 'und',
  niu: 'und',
  g: 'g',
  gr: 'g',
  grs: 'g',
  gramo: 'g',
  gramos: 'g',
  kg: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogramo: 'kg',
  kilogramos: 'kg',
  l: 'l',
  lt: 'l',
  lts: 'l',
  litro: 'l',
  litros: 'l',
  ml: 'ml',
  mililitro: 'ml',
  mililitros: 'ml',
};

/** La unidad escrita de una sola forma ("Unidades" → "und", "Gr" → "g"). */
export function canonicalUnit(unit?: string | null): string {
  const clean = (unit ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.$/, '');
  return UNIT_ALIASES[clean] ?? clean;
}

export interface MergeableProduct {
  name: string;
  unit: string;
  active?: boolean;
  mergedInto?: unknown;
  variantAxes?: unknown[] | null;
}

/**
 * Por qué NO se puede fusionar `source` en `target`, o `null` si se puede.
 *
 * La regla que más importa es la unidad: las existencias se SUMAN, y 3 kg más
 * 5 unidades no son 8 de nada. Fusionar eso dejaría el inventario diciendo una
 * cantidad que no existe, sin forma de saber después cuánto era de cada uno.
 */
export function mergeProblem(
  target: MergeableProduct,
  source: MergeableProduct,
): string | null {
  if (target.mergedInto) {
    return `"${target.name}" ya se fusionó en otro producto: fusiona en ese.`;
  }
  if (target.active === false) {
    return `"${target.name}" está inactivo: actívalo o elige otro como el producto que se queda.`;
  }
  if (source.mergedInto) {
    return `"${source.name}" ya se había fusionado antes.`;
  }
  if (target.variantAxes?.length || source.variantAxes?.length) {
    return 'Un producto con variantes (tallas, colores) no se puede fusionar entero: fusiona sus variantes una por una.';
  }
  if (canonicalUnit(target.unit) !== canonicalUnit(source.unit)) {
    return `No se puede fusionar "${source.name}" (${source.unit}) con "${target.name}" (${target.unit}): se miden en unidades distintas y las existencias quedarían mal sumadas.`;
  }
  return null;
}
