/**
 * Contingencia de la factura electrónica y del documento equivalente POS
 * (Fase 9). Dominio puro: sin Nest, sin Mongoose, sin red.
 *
 * Fuentes:
 * - Res. DIAN 000165 de 2023, art. 37 (inconvenientes tecnológicos); compilada
 *   en la Res. 227 de 2025, art. 1.5.1.5.7.1.
 * - Anexo técnico FEV 1.9, §12 «Suplemento C» (§12.1 tipo 03, §12.2 tipo 04,
 *   §12.3.1 reintentos) y §11.1.4.2 (CUDE del tipo 03 con el PIN).
 * - Anexo técnico DE v1.0 (POS), §15 y §16.3/§16.4.1: tipos 07 y 08 con
 *   `CustomizationID` 20 (estudio `fe-fase7-anexo-pos.md`, D6).
 *
 * Los cuatro tipos:
 *
 * | Falla           | Factura (FEV) | POS | Número                         | Código único          |
 * |-----------------|---------------|-----|--------------------------------|-----------------------|
 * | De la DIAN      | 04            | 08  | el MISMO del documento         | el mismo (no cambia)  |
 * | Del facturador  | 03            | 07  | numeración de contingencia     | CUDE con el PIN       |
 *
 * - DIAN (04/08): se reintenta el envío dos veces más con 5 s entre intentos;
 *   si sigue sin respuesta, el MISMO documento (prefijo, número y CUFE/CUDE: el
 *   código no incluye el `InvoiceTypeCode`) se vuelve a firmar con el tipo de
 *   contingencia y queda en cola. El plazo de 48 h corre desde que la DIAN
 *   vuelve a responder (`restablecidoAt`).
 * - Facturador (03/07): el negocio vendió sin BookiPos (talonario o venta sin
 *   conexión). Superada la falla se transcribe con la numeración de
 *   contingencia de la sede y se transmite; el plazo de 48 h corre desde que se
 *   superó la falla (`superadaAt`).
 * - Las notas y la nómina no tienen contingencia: esperan en cola.
 */

export const TIPOS_CONTINGENCIA = ['03', '04', '07', '08'] as const;
export type TipoContingencia = (typeof TIPOS_CONTINGENCIA)[number];

export type FallaContingencia = 'dian' | 'facturador';

/** Plazo para transmitir lo expedido en contingencia (art. 37; anexo FEV §12.1-12.2). */
export const PLAZO_TRANSMISION_HORAS = 48;

/** La alerta diaria avisa cuando quedan menos de estas horas (o ya venció). */
export const ALERTA_HORAS_ANTES_DEL_PLAZO = 24;

/** §12.2 y anexo DE §15: el envío y dos reintentos, 5 s entre uno y otro. */
export const INTENTOS_ANTES_DE_CONTINGENCIA = 3;
export const ESPERA_ENTRE_INTENTOS_MS = 5_000;

const HORA_MS = 3_600_000;

/** Tipo de contingencia que corresponde a un documento y a una falla. Solo factura y POS la tienen. */
export function tipoContingencia(tipoDoc: string, falla: FallaContingencia): TipoContingencia | null {
  if (tipoDoc === 'invoice') return falla === 'dian' ? '04' : '03';
  if (tipoDoc === 'pos') return falla === 'dian' ? '08' : '07';
  return null;
}

export function esTipoContingencia(v: unknown): v is TipoContingencia {
  return typeof v === 'string' && (TIPOS_CONTINGENCIA as readonly string[]).includes(v);
}

/** ¿El tipo es de falla de la DIAN (04/08) o del facturador (03/07)? */
export function fallaDe(tipo: TipoContingencia): FallaContingencia {
  return tipo === '04' || tipo === '08' ? 'dian' : 'facturador';
}

/** Lo que cambia en el encabezado del `Invoice` por la contingencia. */
export interface EncabezadoContingencia {
  invoiceTypeCode: TipoContingencia;
  /** FEV: la operación sigue siendo 10. POS: 20 con 07/08 (anexo DE §16.4.1). */
  customizationId: string;
  /**
   * `schemeName` del UUID. La FEV 03 se calcula con el PIN (CUDE, §11.1.4.2
   * nota 2); la 04 conserva el CUFE con la clave técnica. El POS es CUDE siempre.
   */
  esquemaCodigoUnico: 'CUFE-SHA384' | 'CUDE-SHA384';
}

export function encabezadoContingencia(tipo: TipoContingencia): EncabezadoContingencia {
  switch (tipo) {
    case '03':
      return { invoiceTypeCode: '03', customizationId: '10', esquemaCodigoUnico: 'CUDE-SHA384' };
    case '04':
      return { invoiceTypeCode: '04', customizationId: '10', esquemaCodigoUnico: 'CUFE-SHA384' };
    case '07':
      return { invoiceTypeCode: '07', customizationId: '20', esquemaCodigoUnico: 'CUDE-SHA384' };
    case '08':
      return { invoiceTypeCode: '08', customizationId: '20', esquemaCodigoUnico: 'CUDE-SHA384' };
  }
}

/**
 * ¿Qué tipo de documento admite el tipo de contingencia? 03/04 son de la
 * factura; 07/08, del POS. Un cruce es un error de flujo.
 */
export function contingenciaDeTipo(tipo: TipoContingencia, tipoDoc: string): boolean {
  return tipoDoc === 'invoice' ? tipo === '03' || tipo === '04' : tipoDoc === 'pos' && (tipo === '07' || tipo === '08');
}

/**
 * ¿Este documento puede pasar a contingencia de la DIAN? Solo la factura y el
 * POS, solo en PRODUCCIÓN (el set de pruebas de habilitación no admite tipos
 * de contingencia) y solo si todavía no es un documento de contingencia.
 */
export function admiteContingenciaDian(d: {
  type: string;
  tipoAmbiente?: string;
  contingencia?: { tipo?: string } | null;
}): boolean {
  return (d.type === 'invoice' || d.type === 'pos') && d.tipoAmbiente === '1' && !d.contingencia?.tipo;
}

/**
 * ¿La respuesta es «sin respuesta de la DIAN»? Red caída, plazo vencido o error
 * del servidor de la DIAN (500, 503, 507, 508, 403 los mapea el adaptador a
 * `RED`). Nunca un veredicto ni un «ya procesado».
 */
export function sinRespuestaDian(r: { codigo?: string; origen?: string }): boolean {
  return r.codigo === 'RED' && r.origen !== 'dian';
}

/** ¿La DIAN contestó algo (veredicto, «ya procesado», «no encontrado»…)? Desde ahí corre el plazo de la 04/08. */
export function dianRespondio(r: { origen?: string }): boolean {
  return r.origen === 'dian';
}

/** La contingencia guardada en el documento (subdocumento `contingencia`). */
export interface ContingenciaDocumento {
  tipo: TipoContingencia;
  /** Cuándo se declaró (04/08) o cuándo se transcribió (03/07). */
  declaradaAt: Date;
  /** 03/07: cuándo se superó la falla (la venta llegó al servidor, o la transcripción). */
  superadaAt?: Date | null;
  /** 04/08: la primera respuesta de la DIAN tras la caída. */
  restablecidoAt?: Date | null;
  /** Documento físico o venta de origen: su referencia y su fecha (AdditionalDocumentReference). */
  referencia?: { id: string; fecha: string } | null;
  /** El documento y todas sus notas quedaron aceptados: sale de la cola. */
  cerradaAt?: Date | null;
}

export type FasePlazo = 'sin_correr' | 'en_plazo' | 'por_vencer' | 'vencido';

export interface EstadoPlazo {
  fase: FasePlazo;
  /** Desde cuándo corre el plazo; null mientras la DIAN siga caída (04/08). */
  inicio: Date | null;
  venceAt: Date | null;
  /** Horas que quedan (enteras hacia arriba); negativas si ya venció. */
  horasRestantes: number | null;
}

/** Inicio del plazo de 48 h: 04/08 desde que la DIAN vuelve; 03/07 desde que se superó la falla. */
export function inicioPlazo(c: Pick<ContingenciaDocumento, 'tipo' | 'declaradaAt' | 'superadaAt' | 'restablecidoAt'>): Date | null {
  if (fallaDe(c.tipo) === 'dian') return c.restablecidoAt ?? null;
  return c.superadaAt ?? c.declaradaAt ?? null;
}

/**
 * Dónde está una contingencia frente al plazo legal. «Por vencer» cuando quedan
 * menos de `ALERTA_HORAS_ANTES_DEL_PLAZO` horas.
 */
export function estadoPlazo(
  c: Pick<ContingenciaDocumento, 'tipo' | 'declaradaAt' | 'superadaAt' | 'restablecidoAt'>,
  ahora: Date = new Date(),
  alertaHoras: number = ALERTA_HORAS_ANTES_DEL_PLAZO,
): EstadoPlazo {
  const inicio = inicioPlazo(c);
  if (!inicio) return { fase: 'sin_correr', inicio: null, venceAt: null, horasRestantes: null };
  const venceAt = new Date(inicio.getTime() + PLAZO_TRANSMISION_HORAS * HORA_MS);
  const restanteMs = venceAt.getTime() - ahora.getTime();
  const horasRestantes = Math.ceil(restanteMs / HORA_MS);
  if (restanteMs <= 0) return { fase: 'vencido', inicio, venceAt, horasRestantes };
  if (restanteMs <= alertaHoras * HORA_MS) return { fase: 'por_vencer', inicio, venceAt, horasRestantes };
  return { fase: 'en_plazo', inicio, venceAt, horasRestantes };
}

/** La resolución de contingencia de la sede, vista solo por lo que se valida aquí. */
export interface ResolucionContingencia {
  prefijo?: string;
  rangoDesde?: number;
  rangoHasta?: number;
  vigenciaDesde?: Date | string;
  vigenciaHasta?: Date | string;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** AAAA-MM-DD de una fecha guardada (Date o texto), sin hora. */
function dia(f: Date | string | undefined): string | undefined {
  if (!f) return undefined;
  if (typeof f === 'string') return FECHA.test(f.slice(0, 10)) ? f.slice(0, 10) : undefined;
  return Number.isNaN(f.getTime()) ? undefined : f.toISOString().slice(0, 10);
}

/**
 * Valida el número y la fecha del talonario (03/07) contra la numeración de
 * contingencia: dentro del rango y de la vigencia, y no posterior a la
 * transcripción. Devuelve el error para la persona o null.
 */
export function errorTalonario(
  t: { numero: number; fecha: string; hoy: string },
  r: ResolucionContingencia,
): string | null {
  const p = r.prefijo ?? '';
  if (!Number.isSafeInteger(t.numero) || t.numero < 1) return 'El número del talonario debe ser un entero positivo.';
  if (!FECHA.test(t.fecha)) return 'La fecha del talonario va en formato AAAA-MM-DD.';
  if (r.rangoDesde !== undefined && r.rangoHasta !== undefined && (t.numero < r.rangoDesde || t.numero > r.rangoHasta)) {
    return `El número ${p}${t.numero} no está en la numeración de contingencia (${p}${r.rangoDesde} a ${p}${r.rangoHasta}).`;
  }
  const desde = dia(r.vigenciaDesde);
  const hasta = dia(r.vigenciaHasta);
  if ((desde && t.fecha < desde) || (hasta && t.fecha > hasta)) {
    return `El talonario es del ${t.fecha}, fuera de la vigencia de la numeración de contingencia (${desde ?? '…'} a ${hasta ?? '…'}).`;
  }
  if (t.fecha > t.hoy) return 'El talonario no puede tener una fecha posterior a la de su transcripción.';
  return null;
}

/** Mensaje a la persona cuando se declara la contingencia de la DIAN. */
export function mensajeContingenciaDian(fullNumber: string, tipo: TipoContingencia, intentos: number): string {
  const quePaso = intentos > 1 ? `La DIAN no respondió después de ${intentos} intentos.` : 'La DIAN no respondió a tiempo.';
  return (
    `${quePaso} El documento ${fullNumber} quedó expedido en contingencia (tipo ${tipo}) y es válido: ` +
    `BookiPos lo transmitirá solo cuando la DIAN vuelva, dentro de las ${PLAZO_TRANSMISION_HORAS} horas que da la norma.`
  );
}
