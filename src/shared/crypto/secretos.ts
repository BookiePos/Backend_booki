import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Schema } from 'mongoose';

/**
 * Cifrado de secretos en la aplicación (Fase 1 de factura electrónica directa a
 * la DIAN). Mongo no tiene pgcrypto, así que la contraseña del .p12, el PIN del
 * software y la clave técnica de cada emisor se cifran aquí, con AES-256-GCM y
 * la llave de `EINVOICING_ENCRYPTION_KEY`, antes de tocar la base.
 *
 * Contrato:
 *   - `cifrar` LANZA si falta la llave: guardar un secreto en claro (o no
 *     guardarlo sin avisar) es peor que un error visible.
 *   - `descifrar` devuelve `null` si falta la llave o el valor: quien lee puede
 *     decir «sin configurar» sin romper la pantalla.
 *   - Un dato, tag, IV o versión alterados LANZAN `SecretoIlegibleError`: nunca
 *     se devuelve basura como si fuera el secreto.
 *   - Una llave mal formada (no son 32 bytes) LANZA en ambos sentidos: es un
 *     error de configuración, no un «falta la llave».
 *
 * `v` es la versión de la llave con la que se cifró. Hoy solo existe la 1; para
 * rotar se añadirá una llave nueva con su versión y se volverá a cifrar.
 *
 * Contexto (obligatorio): `${emisorId}:${nombreCampo}`, p. ej.
 * `66f0…a1:claveTecnica`. Va como dato asociado (AAD) del cifrado, así que un
 * valor copiado a otro emisor o a otro campo deja de descifrar. Ármalo siempre
 * con `contextoSecreto(emisorId, campo)` y con el mismo id al cifrar y al leer.
 */

export const VARIABLE_LLAVE = 'EINVOICING_ENCRYPTION_KEY';

/** Versión de la llave vigente. Sube al rotar. */
export const VERSION_LLAVE = 1;

const ALGORITMO = 'aes-256-gcm';
const BYTES_LLAVE = 32;
/** 12 bytes es el tamaño de IV recomendado para GCM (NIST SP 800-38D). */
const BYTES_IV = 12;
const BYTES_TAG = 16;

/** Secreto cifrado tal como se guarda en Mongo. Todo en base64. */
export interface SecretoCifrado {
  iv: string;
  tag: string;
  data: string;
  v: number;
}

/** El secreto existe pero no se pudo descifrar: alterado, truncado o de otra llave. */
export class SecretoIlegibleError extends Error {
  constructor(motivo: string) {
    super(`Secreto cifrado ilegible: ${motivo}`);
    this.name = 'SecretoIlegibleError';
  }
}

/** La llave del entorno no sirve (longitud o formato). */
export class LlaveInvalidaError extends Error {
  constructor(motivo: string) {
    super(`${VARIABLE_LLAVE} inválida: ${motivo}`);
    this.name = 'LlaveInvalidaError';
  }
}

const RE_HEX = /^[0-9a-fA-F]+$/;
const RE_BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Lee la llave del entorno. `null` si no está; lanza si está pero no son
 * exactamente 32 bytes en hex (64 caracteres) o en base64/base64url.
 */
export function leerLlave(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const cruda = env[VARIABLE_LLAVE]?.trim();
  if (!cruda) return null;
  let llave: Buffer;
  if (cruda.length === BYTES_LLAVE * 2 && RE_HEX.test(cruda)) {
    llave = Buffer.from(cruda, 'hex');
  } else if (RE_BASE64.test(cruda)) {
    llave = Buffer.from(cruda.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } else {
    throw new LlaveInvalidaError('debe ir en hex o en base64');
  }
  if (llave.length !== BYTES_LLAVE) {
    throw new LlaveInvalidaError(`debe tener ${BYTES_LLAVE} bytes y tiene ${llave.length}`);
  }
  return llave;
}

const RE_CONTEXTO = /^[^:\s]+:[^:\s]+$/;

/** Arma el contexto `${emisorId}:${nombreCampo}` de un secreto. */
export function contextoSecreto(emisorId: string, nombreCampo: string): string {
  return validarContexto(`${emisorId}:${nombreCampo}`);
}

function validarContexto(contexto: string): string {
  if (typeof contexto !== 'string' || !RE_CONTEXTO.test(contexto)) {
    // Error de programación: sin contexto el secreto se podría trasplantar.
    throw new Error('Contexto de secreto inválido: debe ser «emisorId:nombreCampo»');
  }
  return contexto;
}

/**
 * Datos asociados (AAD): la versión entra en el tag, así que cambiar `v` en la
 * base también rompe la verificación, y el contexto ata el secreto a su
 * emisor y a su campo.
 */
function aad(v: number, contexto: string): Buffer {
  return Buffer.from(`bookipos-secreto:v${v}:${contexto}`, 'utf8');
}

/** Cifra un texto. Lanza si falta la llave o si es inválida. IV aleatorio en cada llamada. */
export function cifrar(
  texto: string,
  contexto: string,
  opciones: { env?: NodeJS.ProcessEnv } = {},
): SecretoCifrado {
  validarContexto(contexto);
  const llave = leerLlave(opciones.env);
  if (!llave) {
    throw new Error(`${VARIABLE_LLAVE} no está configurada: no se puede guardar el secreto`);
  }
  const iv = randomBytes(BYTES_IV);
  const cifrador = createCipheriv(ALGORITMO, llave, iv, { authTagLength: BYTES_TAG });
  cifrador.setAAD(aad(VERSION_LLAVE, contexto));
  const data = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cifrador.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    v: VERSION_LLAVE,
  };
}

/** Reconoce la forma `{ iv, tag, data, v }` (sirve también al filtro de logs). */
export function esSecretoCifrado(valor: unknown): valor is SecretoCifrado {
  if (!valor || typeof valor !== 'object') return false;
  const s = valor as Record<string, unknown>;
  return (
    typeof s.iv === 'string' &&
    typeof s.tag === 'string' &&
    typeof s.data === 'string' &&
    typeof s.v === 'number'
  );
}

/**
 * Descifra un secreto. `null` si falta la llave o el valor. Lanza
 * `SecretoIlegibleError` si el valor está alterado o no corresponde a la llave
 * o al contexto, y `LlaveInvalidaError` si la llave está mal formada.
 */
export function descifrar(
  secreto: SecretoCifrado | null | undefined,
  contexto: string,
  opciones: { env?: NodeJS.ProcessEnv } = {},
): string | null {
  validarContexto(contexto);
  if (secreto == null) return null;
  const llave = leerLlave(opciones.env);
  if (!llave) return null;
  if (!esSecretoCifrado(secreto)) throw new SecretoIlegibleError('forma inesperada');
  if (secreto.v !== VERSION_LLAVE) {
    throw new SecretoIlegibleError(`versión de llave desconocida (${secreto.v})`);
  }
  const iv = Buffer.from(secreto.iv, 'base64');
  const tag = Buffer.from(secreto.tag, 'base64');
  // Sin estas comprobaciones Node acepta tags cortos, que debilitan la verificación.
  if (iv.length !== BYTES_IV) throw new SecretoIlegibleError('IV de longitud inválida');
  if (tag.length !== BYTES_TAG) throw new SecretoIlegibleError('tag de longitud inválida');
  try {
    const descifrador = createDecipheriv(ALGORITMO, llave, iv, { authTagLength: BYTES_TAG });
    descifrador.setAAD(aad(secreto.v, contexto));
    descifrador.setAuthTag(tag);
    const texto = Buffer.concat([
      descifrador.update(Buffer.from(secreto.data, 'base64')),
      descifrador.final(),
    ]);
    return texto.toString('utf8');
  } catch {
    // El mensaje de Node no aporta y podría variar; el motivo es siempre el mismo.
    throw new SecretoIlegibleError('la verificación de integridad falló');
  }
}

/** Alias del contrato de la checklist: `set` cifra, `get` descifra. */
export const set = cifrar;
export const get = descifrar;

/**
 * Al serializar a JSON, el secreto desaparece: devolver `null` en el transform
 * hace que Mongoose omita el campo en `toJSON()` (y en `JSON.stringify`).
 */
function sinSecreto(): null {
  return null;
}

/**
 * Subesquema de Mongoose para un secreto cifrado. Sin `_id` y estricto: no se
 * cuela nada más que las cuatro piezas. `toJSON` lo omite, así que ni la
 * respuesta de `create()`/`save()` ni un `.select('+campo')` llegan al JSON
 * de una respuesta. `toObject` lo conserva a propósito: el código del servidor
 * lo usa para leer el secreto o para reescribir el documento
 * (`replaceOne(f, doc.toObject())`), y omitirlo ahí lo haría pasar por «sin
 * configurar» o lo borraría de la base.
 */
export const SecretoCifradoSchema = new Schema<SecretoCifrado>(
  {
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    data: { type: String, required: true },
    v: { type: Number, required: true },
  },
  {
    _id: false,
    strict: true,
    toJSON: { transform: sinSecreto },
  },
);

/**
 * Opciones de `@Prop` para un campo secreto: `select: false` para que ninguna
 * consulta lo traiga sin pedirlo con `.select('+campo')`.
 *
 *   @Prop(campoSecreto()) claveTecnica?: SecretoCifrado;
 *
 * Para leerlo: `doc.get('claveTecnica')`, `doc.claveTecnica` o
 * `doc.toObject().claveTecnica`, y luego
 * `descifrar(valor, contextoSecreto(emisorId, 'claveTecnica'))`.
 *
 * Reglas para quien lo use (el esquema no las puede cubrir):
 *   - `aggregate()` y `.lean()` devuelven objetos planos sin transform: el
 *     valor cifrado viaja tal cual. En un `$project` excluye el campo
 *     (`{ claveTecnica: 0 }`) y nunca devuelvas un resultado así en un DTO.
 *   - `toObject()` conserva el secreto: no devuelvas su resultado en una
 *     respuesta HTTP ni lo loguees sin `redactar` (el `LoggerSeguro` ya lo hace).
 *   - No llames `toJSON({ transform })` con un transform propio sobre un
 *     documento con secretos: reemplaza el del subesquema y el valor cifrado
 *     sale en el JSON. Si hace falta un transform, que borre también estos campos.
 *   - Ningún DTO de respuesta declara estos campos; la UI recibe a lo sumo un
 *     booleano «configurado».
 */
export function campoSecreto(): {
  type: typeof SecretoCifradoSchema;
  select: false;
  required: false;
} {
  return { type: SecretoCifradoSchema, select: false, required: false };
}
