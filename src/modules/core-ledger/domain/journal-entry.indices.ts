/**
 * Índices únicos del libro diario (checklist 1.13). Viven aquí, y no solo en el
 * esquema, para que el script en seco de duplicados y las pruebas usen
 * exactamente la misma definición que crea Mongo.
 *
 * 1. Un solo asiento VIVO por evento de negocio: (sourceType, sourceId) es
 *    único entre los asientos originales (no contra-asientos) que no han sido
 *    reversados y que tienen `sourceId`. Quedan fuera, a propósito:
 *    - los contra-asientos (`reversal:*`, `reversalOf` con id), que comparten
 *      el `sourceId` del original;
 *    - los originales ya reversados (`reversedBy` con id): editar un gasto
 *      reversa su asiento y postea otro con el mismo origen;
 *    - los asientos sin `sourceId` (los manuales de la pantalla no lo llevan).
 *    Se filtra con `$type: 'null'` (y no con `{ campo: null }`) porque es la
 *    forma que admite un índice parcial; el esquema escribe `null` explícito
 *    por defecto en `reversalOf` y `reversedBy`.
 * 2. Un solo contra-asiento por asiento: `reversalOf` único cuando existe. Dos
 *    reversas simultáneas del mismo asiento dejarían el doble de lo anulado.
 */

export const INDICE_ORIGEN_VIVO = {
  keys: { sourceType: 1, sourceId: 1 },
  options: {
    name: 'origen_vivo_unico',
    unique: true,
    partialFilterExpression: {
      sourceId: { $type: 'string' },
      reversalOf: { $type: 'null' },
      reversedBy: { $type: 'null' },
    },
  },
} as const;

export const INDICE_UNA_REVERSA = {
  keys: { reversalOf: 1 },
  options: {
    name: 'una_reversa_por_asiento',
    unique: true,
    partialFilterExpression: { reversalOf: { $type: 'objectId' } },
  },
} as const;

/**
 * `sourceType` que postea el sistema. Un asiento manual (POST /ledger/entries)
 * no puede usarlos: ocuparía el lugar del asiento real en el índice y el
 * posteo automático lo tomaría por «ya posteado».
 */
export const ORIGENES_AUTOMATICOS: readonly string[] = [
  'sale',
  'sale_return',
  'expense',
  'payable_payment',
  'receivable_payment',
  'purchase_receipt',
  'payroll_run',
  'reclasificacion_puc',
];

export function esOrigenReservado(sourceType: string): boolean {
  return (
    sourceType.startsWith('reversal:') ||
    ORIGENES_AUTOMATICOS.includes(sourceType)
  );
}

/** ¿El error es un E11000 sobre el índice indicado? */
export function esDuplicadoEn(
  err: unknown,
  indice: { keys: Record<string, number>; options: { name: string } },
): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
  if (e.code !== 11000) return false;
  if (e.keyPattern) {
    const a = Object.keys(e.keyPattern).sort().join(',');
    const b = Object.keys(indice.keys).sort().join(',');
    return a === b;
  }
  return String(e.message ?? '').includes(indice.options.name);
}
