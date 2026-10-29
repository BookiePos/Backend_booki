/**
 * Tipos de documento que pueden tener resolución de numeración propia.
 *
 * La DIAN autoriza la numeración por tipo de documento y por punto de venta: la
 * factura de venta, el documento equivalente POS, las notas crédito y débito y
 * la contingencia llevan rangos y prefijos distintos. Una sede (punto de venta)
 * puede tener UNA resolución por tipo.
 *
 * Dominio puro: sin Nest ni Mongoose.
 */
export const TIPOS_RESOLUCION = [
  'invoice',
  'pos',
  'credit_note',
  'debit_note',
  'contingency',
] as const;
export type TipoResolucion = (typeof TIPOS_RESOLUCION)[number];

/** El tipo que tienen las resoluciones que ya existían antes de esta división. */
export const TIPO_RESOLUCION_POR_DEFECTO: TipoResolucion = 'invoice';

/** La sede, vista solo por lo que importa aquí. */
export interface SedeConResoluciones<R extends object> {
  /** La de factura (campo histórico: aquí siguen viviendo las existentes). */
  resolucionFe?: R | null;
  /** Las de los demás tipos. */
  resolucionesFe?: R[] | null;
}

/**
 * Resolución vigente de la sede para un tipo de documento.
 *
 * La factura sigue en `resolucionFe` (así las sedes existentes no necesitan
 * migración y el resto del código que la lee no cambia); los demás tipos viven
 * en `resolucionesFe`.
 */
export function resolucionDeTipo<R extends object>(
  sede: SedeConResoluciones<R>,
  tipo: TipoResolucion,
): R | undefined {
  if (tipo === 'invoice') return sede.resolucionFe ?? undefined;
  return (sede.resolucionesFe ?? []).find(
    (r) => (r as { tipoDocumento?: TipoResolucion }).tipoDocumento === tipo,
  );
}

/**
 * Id del contador atómico del consecutivo.
 *
 * El de la factura conserva el id de siempre (`fe:<sede>:<prefijo>`): cambiarlo
 * reiniciaría la numeración de todas las sedes. Los demás tipos llevan el tipo
 * en el id para no compartir contador aunque repitan prefijo.
 */
export function contadorDeResolucion(
  tipo: TipoResolucion,
  sedeId: string,
  prefijo: string | undefined,
): string {
  const p = prefijo ?? '';
  return tipo === 'invoice' ? `fe:${sedeId}:${p}` : `fe:${tipo}:${sedeId}:${p}`;
}

/** Nombre legible del tipo, para los mensajes de error al usuario. */
export const NOMBRE_TIPO_RESOLUCION: Record<TipoResolucion, string> = {
  invoice: 'factura de venta',
  pos: 'documento equivalente POS',
  credit_note: 'nota crédito',
  debit_note: 'nota débito',
  contingency: 'contingencia',
};
