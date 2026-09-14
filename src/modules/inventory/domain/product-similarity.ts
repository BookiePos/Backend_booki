/**
 * Parecido entre nombres de producto, para no llenar el inventario de
 * duplicados. Dominio puro.
 *
 * Lo usan dos lados que tienen que decir lo mismo: la lectura de facturas
 * (¿"COCA COLA REGULAR FRIOPACK" es la "Coca cola original" que ya existe?) y
 * la fusión de productos (¿qué otros productos se parecen a este?). El
 * frontend tiene un espejo en `lib/erp/product-match.ts` para las sugerencias.
 */

/** Por debajo de esto, dos nombres no se sugieren como el mismo producto. */
export const SIMILAR_MIN_SCORE = 0.3;

/** Palabras que aparecen en todas las descripciones y no distinguen nada. */
const STOP_WORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'con',
  'sin',
  'por',
  'para',
  'y',
  'x',
  'und',
  'unidad',
  'unidades',
  'ref',
]);

/** Unidades de una letra que sí distinguen ("1 l" no es "1 kg"). */
const SHORT_UNITS = new Set(['l', 'g']);

/** Formas de escribir la misma unidad. */
const UNIT_WORDS: Record<string, string> = {
  gr: 'g',
  grs: 'g',
  gramo: 'g',
  gramos: 'g',
  kilo: 'kg',
  kilos: 'kg',
  kilogramo: 'kg',
  kilogramos: 'kg',
  lt: 'l',
  lts: 'l',
  litro: 'l',
  litros: 'l',
  mililitro: 'ml',
  mililitros: 'ml',
  cc: 'ml',
};

interface NameParts {
  words: Set<string>;
  numbers: Set<string>;
}

function parts(value: string): NameParts {
  const raw =
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .match(/\d+(?:[.,]\d+)?|[a-z]+/g) ?? [];
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const token of raw) {
    if (/^\d/.test(token)) {
      // "1,5" y "1.5" son el mismo tamaño; "012" y "12" también.
      numbers.add(String(Number(token.replace(',', '.'))));
      continue;
    }
    const word = UNIT_WORDS[token] ?? token;
    if (STOP_WORDS.has(word)) continue;
    if (word.length < 2 && !SHORT_UNITS.has(word)) continue;
    words.add(word);
  }
  return { words, numbers };
}

/**
 * Parecido entre dos nombres, de 0 a 1.
 *
 * Mezcla dos medidas porque cada una sola falla en un caso real:
 * - **Jaccard** (compartidas / todas) castiga las palabras de más: "Coca cola
 *   original" contra "Coca cola regular friopack" daba 0,40 y nunca se
 *   sugería, aunque es obvio que puede ser el mismo producto.
 * - **Contención** (compartidas / las del nombre más corto) premia que un
 *   nombre esté dentro del otro, pero sola emparejaría "Coca cola" con
 *   cualquier cosa que diga coca cola.
 *
 * Y los **tamaños** mandan: si los dos nombres traen cifras y no comparten
 * ninguna ("500 g" contra "1000 g"), son presentaciones distintas aunque todo
 * lo demás coincida, y el puntaje se parte a la mitad.
 */
export function productSimilarity(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (left.words.size === 0 || right.words.size === 0) return 0;

  let shared = 0;
  for (const word of left.words) {
    if (right.words.has(word)) shared += 1;
  }
  if (shared === 0) return 0;

  const jaccard = shared / (left.words.size + right.words.size - shared);
  const containment = shared / Math.min(left.words.size, right.words.size);
  let score = (jaccard + containment) / 2;

  if (left.numbers.size > 0 && right.numbers.size > 0) {
    const sameSize = [...left.numbers].some((n) => right.numbers.has(n));
    if (!sameSize) score /= 2;
  }
  return Math.round(score * 100) / 100;
}

/** Los más parecidos a `query`, de mayor a menor. */
export function rankBySimilarity<T>(
  query: string,
  items: readonly T[],
  nameOf: (item: T) => string,
  { min = SIMILAR_MIN_SCORE, limit = 5 }: { min?: number; limit?: number } = {},
): { item: T; score: number }[] {
  return items
    .map((item) => ({ item, score: productSimilarity(query, nameOf(item)) }))
    .filter((candidate) => candidate.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
