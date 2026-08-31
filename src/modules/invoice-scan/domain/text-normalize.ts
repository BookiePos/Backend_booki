/**
 * Normalización de texto para emparejar lo que dice la factura con lo que hay
 * en el catálogo. Dominio puro.
 *
 * El proveedor escribe "GASEOSA POSTOBON 350ML X 12"; en el inventario está
 * como "Gaseosa Postobón 350 ml". Sin normalizar, ninguna comparación acierta.
 */

/**
 * Minúsculas, sin tildes, sin puntuación y con espacios colapsados.
 *
 * Además **separa números de letras**: "350ml" pasa a "350 ml". En las facturas
 * la unidad va pegada a la cifra tan a menudo como separada, y sin esto
 * "GASEOSA 350ML" y "Gaseosa 350 ml" no compartían ni una palabra con tamaño,
 * que es justo lo que distingue un producto de otro.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Palabras significativas para comparar. Se descartan las de una sola letra y
 * las muletillas de las facturas, que aparecen en todas las líneas y solo
 * generan coincidencias falsas.
 */
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
  'und',
  'unidad',
  'unidades',
  'caja',
  'paquete',
  'ref',
]);

export function tokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/**
 * Similitud entre dos descripciones, de 0 a 1 (índice de Jaccard sobre sus
 * palabras significativas).
 *
 * Se eligió Jaccard y no una distancia de edición porque el problema real es el
 * ORDEN y las palabras de más ("gaseosa postobon 350ml" vs "postobon gaseosa
 * 350 ml x12"), no las erratas de una letra. Jaccard ignora el orden y castiga
 * lo que sobra en cada lado, que es justo lo que queremos.
 */
export function similarity(a: string, b: string): number {
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const word of setA) {
    if (setB.has(word)) shared += 1;
  }
  return shared / (setA.size + setB.size - shared);
}
