/** Qué operación del libro falló y quedó por conciliar. */
export const OPERACIONES_CONCILIACION = ['post', 'reverse'] as const;
export type OperacionConciliacion = (typeof OPERACIONES_CONCILIACION)[number];

export interface FalloDelLibro {
  sourceType: string;
  sourceId: string;
  operacion: OperacionConciliacion;
  error: string;
}
