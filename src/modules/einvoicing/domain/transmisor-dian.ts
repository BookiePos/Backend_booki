import type { DocType } from './einvoicing.constants';

/**
 * Puerto de transmisión a la DIAN. El dominio solo conoce esta interfaz; la
 * implementación directa (SOAP + WS-Security con el .p12 del negocio) llega en
 * las Fases 3-4. Mientras tanto solo existe `StubDian`.
 */

/** Quién produjo la respuesta: el propio adaptador (red, config) o la DIAN. */
export type OrigenRespuesta = 'adapter' | 'dian';

/**
 * Respuesta normalizada de cualquier operación contra la DIAN.
 *
 * Contrato fail-closed: `ok: true` solo con `isValid === true` y
 * `origen === 'dian'`. `isValid` solo se llena cuando la DIAN dio veredicto;
 * un fallo del adaptador (red, timeout, configuración) nunca lo trae.
 */
export interface RespuestaDian {
  ok: boolean;
  /** Veredicto de la DIAN (IsValid). Ausente si no hubo veredicto. */
  isValid?: boolean;
  /** Código de la DIAN o del adaptador (ver `CODIGOS_SIN_VEREDICTO`). */
  codigo?: string;
  origen: OrigenRespuesta;
  mensajes: string[];
  /** Identificador del envío asíncrono (set de pruebas). */
  trackId?: string;
  zipKey?: string;
  cufe?: string;
  /**
   * ApplicationResponse de la DIAN (base64 del `XmlBase64Bytes`), SOLO en una
   * aceptación cuyo XML se validó contra el CUFE. No es un mensaje: no se
   * loguea ni se vuelca a `mensajes`.
   */
  applicationResponse?: string;
}

/**
 * Lanza si la respuesta rompe el contrato fail-closed. `ok` es bicondicional:
 * solo es true con `isValid === true` y `origen === 'dian'`, y en ese caso
 * tiene que serlo (`ok:false` con veredicto válido de la DIAN es incoherente).
 */
export function assertContratoRespuesta(r: RespuestaDian): void {
  if (r.ok !== (r.isValid === true && r.origen === 'dian')) {
    throw new Error(
      'Respuesta DIAN inválida: ok debe ser true solo con isValid=true y origen dian',
    );
  }
}

/**
 * Presupuesto de tiempo de una llamada de red. El orquestador lo calcula para
 * que la llamada termine antes de que venza su bloqueo del documento; la
 * implementación DEBE respetarlo (timeout del SOAP ≤ `presupuestoMs` y abortar
 * con `signal`). Opcional para no romper a quien no lo use todavía.
 */
export interface PresupuestoRed {
  presupuestoMs?: number;
  signal?: AbortSignal;
}

/** Documento ya firmado, listo para transmitir. */
export interface EnvioDian extends PresupuestoRed {
  tipo: DocType;
  fullNumber: string;
  cufe?: string;
  /** XML UBL 2.1 firmado (XAdES-EPES). */
  xmlFirmado?: string;
}

export interface EnvioSetPruebasDian extends EnvioDian {
  testSetId?: string;
}

export interface ConsultaDian extends PresupuestoRed {
  trackId?: string;
  cufe?: string;
}

export interface RangoNumeracionDian {
  prefijo?: string;
  desde: number;
  hasta: number;
  resolucion?: string;
  claveTecnica?: string;
}

export interface RespuestaRangosDian extends RespuestaDian {
  rangos: RangoNumeracionDian[];
}

export interface TransmisorDian {
  /** Envío sincrónico de un documento firmado. */
  enviar(entrada: EnvioDian): Promise<RespuestaDian>;
  /** Envío al set de pruebas de habilitación. */
  enviarSetPruebas(entrada: EnvioSetPruebasDian): Promise<RespuestaDian>;
  /** Consulta el estado por trackId o CUFE (idempotencia: nunca renumera). */
  consultar(consulta: ConsultaDian): Promise<RespuestaDian>;
  /** Rangos de numeración autorizados al emisor. */
  rangos(nit: string): Promise<RespuestaRangosDian>;
}
