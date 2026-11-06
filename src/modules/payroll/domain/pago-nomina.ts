/**
 * Pago de la nómina: medio y fecha REAL del egreso, que el negocio declara al
 * cerrar la corrida (decisión 1 del dueño, tarea 11). La nómina electrónica
 * los reporta en `Pago@Metodo` y `FechasPagos/FechaPago`; sin ellos el
 * consolidador no arma el documento.
 */

/** Medios con que se paga una nómina (tabla 5.3.3.2 del anexo): efectivo, cheque, consignación y transferencia débito. */
export const MEDIOS_PAGO_NOMINA = ['10', '20', '42', '47'] as const;
export type MedioPagoNomina = (typeof MEDIOS_PAGO_NOMINA)[number];

export const NOMBRE_MEDIO_PAGO: Record<MedioPagoNomina, string> = {
  '10': 'efectivo',
  '20': 'cheque',
  '42': 'consignación',
  '47': 'transferencia',
};

export interface PagoNomina {
  medio: MedioPagoNomina;
  /** YYYY-MM-DD */
  fecha: string;
}

const esFechaReal = (f: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
};

/**
 * Valida el pago declarado para la corrida del `periodo` (YYYY-MM). `hoy` es la
 * fecha de Colombia (YYYY-MM-DD): la fecha es la del egreso REAL, así que no
 * puede ser futura ni anterior al mes liquidado. Devuelve el motivo o null.
 */
export function motivoPagoInvalido(periodo: string, medio: string, fecha: string, hoy: string): string | null {
  if (!(MEDIOS_PAGO_NOMINA as readonly string[]).includes(medio)) {
    return 'El medio de pago debe ser efectivo (10), cheque (20), consignación (42) o transferencia (47).';
  }
  if (!esFechaReal(fecha)) return 'La fecha de pago no es una fecha válida (YYYY-MM-DD).';
  if (fecha < `${periodo}-01`) return `La fecha de pago (${fecha}) no puede ser anterior al mes liquidado (${periodo}).`;
  if (fecha > hoy) return `La fecha de pago (${fecha}) es futura: declara la fecha real en que se pagó.`;
  return null;
}
