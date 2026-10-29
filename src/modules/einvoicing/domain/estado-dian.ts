import type { DianStatus } from './einvoicing.constants';
import type { RespuestaDian } from './transmisor-dian';

/**
 * Máquina de estados del documento ante la DIAN (pura, sin I/O).
 *
 * draft → signed → sent → accepted | rejected, más contingency.
 *
 * Reglas fail-closed:
 *  - `rejected` solo se escribe con un veredicto real de la DIAN
 *    (`esVeredictoDian` con `isValid === false`). Red, timeout, set en
 *    validación o configuración faltante NO son rechazo.
 *  - Lo que está en vuelo (`sent`, o una respuesta sin veredicto) nunca pasa a
 *    `accepted`/`rejected` sin veredicto y nunca se renumera: reemitirlo con
 *    otro número duplicaría la venta. Un rechazo se corrige y se reenvía con el
 *    mismo número.
 */

/**
 * Códigos que NO son veredicto: el documento queda como estaba (o en vuelo).
 * - RED: red o timeout contra la DIAN.
 * - PENDIENTE_DIAN: la DIAN aún valida (set en validación).
 * - NO_RECIBIDO_DIAN: la DIAN no confirma haberlo recibido.
 * - CONFIG_FALTANTE: sin .p12 vigente, SoftwareID o PIN; no salió a la red.
 */
export const CODIGOS_SIN_VEREDICTO = [
  'RED',
  'PENDIENTE_DIAN',
  'NO_RECIBIDO_DIAN',
  'CONFIG_FALTANTE',
] as const;
export type CodigoSinVeredicto = (typeof CODIGOS_SIN_VEREDICTO)[number];

type RespuestaMinima = Pick<RespuestaDian, 'origen' | 'isValid' | 'codigo'>;

/** Transiciones permitidas. `sent → sent` es la reconsulta sin veredicto. */
const TRANSICIONES: Record<DianStatus, readonly DianStatus[]> = {
  draft: ['signed', 'contingency'],
  signed: ['sent', 'contingency'],
  sent: ['sent', 'accepted', 'rejected', 'contingency'],
  // Corregido el motivo, se vuelve a firmar con el MISMO número.
  rejected: ['signed'],
  accepted: [],
  contingency: ['sent'],
};

export function transicionPermitida(
  desde: DianStatus,
  hacia: DianStatus,
): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

/** Lanza si la transición no está permitida. */
export function assertTransicion(desde: DianStatus, hacia: DianStatus): void {
  if (!transicionPermitida(desde, hacia)) {
    throw new Error(`Transición DIAN no permitida: ${desde} → ${hacia}`);
  }
}

/**
 * ¿La respuesta es un veredicto de la DIAN? Única puerta para escribir
 * `rejected`: exige origen DIAN, `IsValid` booleano y un código fuera de la
 * lista negra.
 */
export function esVeredictoDian(r: RespuestaMinima): boolean {
  if (r.origen !== 'dian') return false;
  if (typeof r.isValid !== 'boolean') return false;
  if (
    r.codigo !== undefined &&
    (CODIGOS_SIN_VEREDICTO as readonly string[]).includes(r.codigo)
  ) {
    return false;
  }
  return true;
}

/** ¿La respuesta deja el documento en vuelo (sin aceptar ni rechazar)? */
export function quedaEnVuelo(r: RespuestaMinima): boolean {
  return !esVeredictoDian(r);
}

/**
 * Estado resultante de aplicar una respuesta a un documento. Con veredicto:
 * `accepted` o `rejected` (solo desde `sent`; desde otro estado es un error de
 * flujo y lanza). Sin veredicto: el documento no se acepta ni se rechaza; solo
 * `PENDIENTE_DIAN` sobre un firmado lo deja en vuelo (`sent`), el resto
 * (RED, CONFIG_FALTANTE...) no lo mueve.
 */
export function estadoTrasRespuesta(
  actual: DianStatus,
  r: RespuestaMinima,
): DianStatus {
  if (esVeredictoDian(r)) {
    const destino: DianStatus = r.isValid ? 'accepted' : 'rejected';
    assertTransicion(actual, destino);
    return destino;
  }
  if (actual === 'signed' && r.codigo === 'PENDIENTE_DIAN') return 'sent';
  return actual;
}
