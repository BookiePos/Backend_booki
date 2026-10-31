import type { DocType } from './einvoicing.constants';
import { TIPOS_AMBIENTE, type TipoAmbiente } from './emisor-fiscal';

/**
 * Gate de ambiente de la transmisión (Fase 4B). Dominio puro: sin Nest, sin
 * Mongoose, sin red.
 *
 * Decide, ANTES de firmar o de salir a la red, si un documento se puede
 * transmitir y a qué ambiente. Reglas (todas fail-closed):
 *
 *  - El ambiente es el del emisor tal cual está guardado ('1' producción, '2'
 *    habilitación). Un valor distinto NO se interpreta como habilitación: es
 *    un error de configuración.
 *  - El documento lleva congelado el ambiente con el que se calculó su
 *    CUFE/CUDE. Tiene que coincidir con el del emisor: un documento de pruebas
 *    jamás va a producción y uno de producción jamás se degrada a habilitación
 *    en silencio. Un documento sin ambiente (anterior a la Fase 2) no se
 *    transmite.
 *  - Producción exige emisor `habilitado === true` (lo enciende BookiPos tras
 *    pasar el set de pruebas) y resolución real: nunca la de pruebas (`SETP`).
 *  - Habilitación no gasta una resolución real: si el documento trae
 *    resolución, tiene que ser la de pruebas.
 *  - El NIT del documento tiene que ser el del emisor (la sede pudo cambiar de
 *    NIT después de emitir: firmar sería hacerlo a nombre de otro facturador).
 *
 * Si algo falla, la respuesta es `CONFIG_FALTANTE` con todos los motivos.
 */

/** Prefijo de las resoluciones del set de pruebas de habilitación de la DIAN. */
export const PREFIJO_RESOLUCION_PRUEBAS = 'SETP';
/** Número de la resolución de pruebas que la DIAN entrega en habilitación. */
export const NUMERO_RESOLUCION_PRUEBAS = '18760000001';

/** Tipos que no se pueden transmitir sin resolución de numeración. */
const TIPOS_CON_RESOLUCION_OBLIGATORIA: readonly DocType[] = ['invoice', 'pos'];

export interface ResolucionParaGate {
  prefijo?: string | null;
  numero?: string | null;
}

export interface EmisorParaGate {
  /** Valor guardado en el emisor, sin normalizar. */
  tipoAmbiente?: string | null;
  habilitado?: boolean | null;
  nitNorm?: string | null;
  /** Lo que le falta para transmitir (certificado, SoftwareID, PIN). */
  faltaParaTransmitir?: readonly string[];
}

export interface DocumentoParaGate {
  tipo: DocType;
  /** Ambiente con el que se calculó el CUFE/CUDE. */
  tipoAmbiente?: string | null;
  nitNorm?: string | null;
  cufe?: string | null;
}

export interface EntradaGateAmbiente {
  emisor: EmisorParaGate | null | undefined;
  resolucion: ResolucionParaGate | null | undefined;
  documento: DocumentoParaGate;
}

export type DecisionAmbiente =
  | { permitido: true; ambiente: TipoAmbiente }
  | { permitido: false; codigo: 'CONFIG_FALTANTE'; motivos: string[] };

const esAmbiente = (v: unknown): v is TipoAmbiente =>
  typeof v === 'string' && (TIPOS_AMBIENTE as readonly string[]).includes(v);

/** ¿La resolución es la del set de pruebas de habilitación? */
export function esResolucionDePruebas(
  r: ResolucionParaGate | null | undefined,
): boolean {
  if (!r) return false;
  const prefijo = (r.prefijo ?? '').trim().toUpperCase();
  const numero = (r.numero ?? '').trim();
  return prefijo === PREFIJO_RESOLUCION_PRUEBAS || numero === NUMERO_RESOLUCION_PRUEBAS;
}

export function decidirAmbiente(e: EntradaGateAmbiente): DecisionAmbiente {
  const motivos: string[] = [];
  const { emisor, resolucion, documento } = e;

  if (!emisor) {
    return {
      permitido: false,
      codigo: 'CONFIG_FALTANTE',
      motivos: ['la sede no tiene emisor fiscal'],
    };
  }

  for (const falta of emisor.faltaParaTransmitir ?? []) {
    motivos.push(`falta ${falta}`);
  }

  if (!documento.cufe?.trim()) motivos.push('el documento no tiene CUFE/CUDE');

  const ambienteEmisor = esAmbiente(emisor.tipoAmbiente) ? emisor.tipoAmbiente : null;
  if (!ambienteEmisor) motivos.push('el emisor no tiene un ambiente DIAN válido');

  const ambienteDoc = esAmbiente(documento.tipoAmbiente) ? documento.tipoAmbiente : null;
  if (!ambienteDoc) {
    motivos.push('el documento no indica con qué ambiente se calculó su CUFE/CUDE');
  }

  if (ambienteEmisor && ambienteDoc && ambienteEmisor !== ambienteDoc) {
    motivos.push(
      ambienteDoc === '2'
        ? 'un documento de pruebas no se transmite a producción'
        : 'un documento de producción no se transmite a habilitación',
    );
  }

  if (!emisor.nitNorm || !documento.nitNorm || emisor.nitNorm !== documento.nitNorm) {
    motivos.push('el NIT del documento no coincide con el del emisor fiscal');
  }

  const dePruebas = esResolucionDePruebas(resolucion);
  if (ambienteEmisor === '1') {
    if (emisor.habilitado !== true) {
      motivos.push('el emisor no está habilitado para producción');
    }
    if (dePruebas) {
      motivos.push('la resolución de pruebas (SETP) no sirve en producción');
    }
    if (!resolucion && TIPOS_CON_RESOLUCION_OBLIGATORIA.includes(documento.tipo)) {
      motivos.push('el documento no tiene resolución de numeración');
    }
  } else if (ambienteEmisor === '2') {
    if (resolucion && !dePruebas) {
      motivos.push('en habilitación solo se usa la resolución de pruebas (SETP)');
    }
  }

  if (motivos.length > 0 || !ambienteEmisor) {
    return { permitido: false, codigo: 'CONFIG_FALTANTE', motivos };
  }
  return { permitido: true, ambiente: ambienteEmisor };
}
