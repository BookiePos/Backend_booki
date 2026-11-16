import {
  cifrar,
  contextoSecreto,
  descifrar,
  VARIABLE_LLAVE,
  type SecretoCifrado,
} from '../../../shared/crypto/secretos';
import {
  TIPO_RESOLUCION_POR_DEFECTO,
  type TipoResolucion,
} from '../../einvoicing/domain/resolucion-tipos';

/**
 * Clave técnica de una resolución de numeración (la que entra en el CUFE).
 *
 * Se guarda cifrada en `claveTecnicaCifrada` (AES-256-GCM, `shared/crypto/secretos`).
 * `claveTecnica` es el campo viejo en claro: solo se LEE como respaldo mientras
 * existan resoluciones sin migrar (`src/datos/2026-11-cifrar-clave-tecnica.ts`);
 * ninguna escritura nueva lo usa.
 *
 * Contexto (AAD) del cifrado: `<sedeId>:resolucion.<tipo>.claveTecnica`.
 *   - `sedeId`: la resolución vive dentro de la sede, su id no cambia nunca y
 *     existe siempre. El emisor no sirve de ancla: es opcional (una sede sin NIT
 *     no tiene) y el enlace se rehace si cambia el NIT.
 *   - `tipo`: una sede tiene UNA resolución por tipo; es la identidad del hueco.
 *   - Sin prefijo ni número: se editan desde la ficha de la sede y se conservan
 *     al renovar sin volver a teclear la clave; atarlos al cifrado dejaría la
 *     clave ilegible tras una edición legítima.
 * Una clave copiada a otra sede, a otro tipo o a otro campo deja de descifrar.
 *
 * Seguridad: nunca loguees lo que devuelve `leerClaveTecnicaDe` ni lo pongas en
 * una respuesta, un error o la auditoría.
 */

/** Campos de la resolución que guardan la clave. Ninguno viaja en una respuesta. */
export interface ResolucionConClave {
  tipoDocumento?: TipoResolucion;
  /** Campo viejo, en claro. Solo lectura de respaldo. */
  claveTecnica?: string | null;
  claveTecnicaCifrada?: SecretoCifrado | null;
  /** Hay clave guardada (lo que sí puede ver la interfaz). */
  tieneClaveTecnica?: boolean | null;
}

/**
 * `select` que trae la clave (cifrada y en claro) de todas las resoluciones.
 * Ambos campos son `select: false`: sin esto ninguna consulta los devuelve.
 */
export const SELECT_CLAVES_TECNICAS =
  '+resolucionFe.claveTecnica +resolucionFe.claveTecnicaCifrada ' +
  '+resolucionesFe.claveTecnica +resolucionesFe.claveTecnicaCifrada';

/** La clave está cifrada pero el servidor no tiene la llave para leerla. */
export class ClaveTecnicaSinLlaveError extends Error {
  constructor() {
    super(`La clave técnica está cifrada y ${VARIABLE_LLAVE} no está configurada: no se puede leer`);
    this.name = 'ClaveTecnicaSinLlaveError';
  }
}

export function contextoClaveTecnica(sedeId: string, tipo: TipoResolucion): string {
  return contextoSecreto(String(sedeId), `resolucion.${tipo}.claveTecnica`);
}

/** Cifra la clave para guardarla. LANZA si falta la llave: nunca se guarda en claro. */
export function cifrarClaveTecnica(
  sedeId: string,
  tipo: TipoResolucion,
  clave: string,
  opciones: { env?: NodeJS.ProcessEnv } = {},
): SecretoCifrado {
  return cifrar(clave, contextoClaveTecnica(sedeId, tipo), opciones);
}

/** Mongoose entrega el secreto como subdocumento; aquí se usa el objeto plano. */
function plano(s: SecretoCifrado): SecretoCifrado {
  const o = s as SecretoCifrado & { toObject?: () => SecretoCifrado };
  const p = typeof o.toObject === 'function' ? o.toObject() : s;
  return { iv: p.iv, tag: p.tag, data: p.data, v: p.v };
}

/**
 * Clave técnica en claro, solo para el servidor (cálculo del CUFE).
 * Lee el campo cifrado y, si no existe, cae al campo viejo en claro.
 * `undefined` si la resolución no tiene clave. Lanza si está cifrada y falta la
 * llave (`ClaveTecnicaSinLlaveError`) o si el valor está alterado
 * (`SecretoIlegibleError`): jamás se emite con una clave a medias.
 */
export function leerClaveTecnicaDe(
  sedeId: string,
  resolucion: ResolucionConClave | null | undefined,
  opciones: { env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  if (!resolucion) return undefined;
  const tipo = resolucion.tipoDocumento ?? TIPO_RESOLUCION_POR_DEFECTO;
  if (resolucion.claveTecnicaCifrada) {
    const clave = descifrar(
      plano(resolucion.claveTecnicaCifrada),
      contextoClaveTecnica(sedeId, tipo),
      opciones,
    );
    if (clave === null) throw new ClaveTecnicaSinLlaveError();
    return clave || undefined;
  }
  const enClaro = typeof resolucion.claveTecnica === 'string' ? resolucion.claveTecnica.trim() : '';
  return enClaro || undefined;
}

/**
 * ¿Hay clave guardada? No descifra. Vale con la marca persistida o con
 * cualquiera de los dos campos si la consulta los trajo.
 */
export function tieneClaveTecnica(resolucion: ResolucionConClave | null | undefined): boolean {
  if (!resolucion) return false;
  return Boolean(
    resolucion.tieneClaveTecnica ||
      resolucion.claveTecnicaCifrada ||
      (typeof resolucion.claveTecnica === 'string' && resolucion.claveTecnica.trim()),
  );
}

/**
 * Los tres campos de la clave para una resolución que se guarda.
 *   - Con clave nueva: se cifra (lanza sin llave) y el claro desaparece.
 *   - Sin clave nueva: se conserva la anterior tal cual esté (cifrada o, si aún
 *     no se migró, en claro). El tipo no cambia, así que el cifrado sigue válido.
 */
export function camposClaveAlGuardar(
  sedeId: string,
  tipo: TipoResolucion,
  claveNueva: string | null | undefined,
  previa: ResolucionConClave | null | undefined,
  opciones: { env?: NodeJS.ProcessEnv } = {},
): { claveTecnica?: string; claveTecnicaCifrada?: SecretoCifrado; tieneClaveTecnica: boolean } {
  const nueva = typeof claveNueva === 'string' ? claveNueva.trim() : '';
  if (nueva) {
    return {
      claveTecnicaCifrada: cifrarClaveTecnica(sedeId, tipo, nueva, opciones),
      claveTecnica: undefined,
      tieneClaveTecnica: true,
    };
  }
  if (previa?.claveTecnicaCifrada) {
    return {
      claveTecnicaCifrada: plano(previa.claveTecnicaCifrada),
      claveTecnica: undefined,
      tieneClaveTecnica: true,
    };
  }
  const enClaro = typeof previa?.claveTecnica === 'string' ? previa.claveTecnica.trim() : '';
  return {
    claveTecnicaCifrada: undefined,
    claveTecnica: enClaro || undefined,
    tieneClaveTecnica: Boolean(enClaro),
  };
}
