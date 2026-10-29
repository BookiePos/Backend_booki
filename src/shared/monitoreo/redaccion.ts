import { ConsoleLogger } from '@nestjs/common';
import { esSecretoCifrado } from '../crypto/secretos';

/**
 * Filtro de secretos para los logs (Fase 1 de factura electrónica). Con el .p12
 * de cada negocio en la base, un `logger.error(dto)` o un mensaje armado con
 * `password=...` no puede dejar la contraseña del certificado, el PIN o la
 * clave técnica en los logs de Vercel ni en Sentry.
 */

export const REDACTADO = '[redactado]';

/**
 * Palabras que delatan un secreto en el nombre de un campo. Se comparan sin
 * mayúsculas ni separadores (`client_secret`, `clientSecret` y `CLIENT-SECRET`
 * son el mismo) y como subcadena: `passwordHash` o `certificadoP12` también caen.
 */
const SUBCADENAS_SENSIBLES = [
  'password',
  'passwd',
  'passphrase',
  'contrasena',
  'clavetecnica',
  'certificado',
  'secret',
  'privatekey',
  'llaveprivada',
  'apikey',
  'token',
  'authorization',
  'cookie',
];

/**
 * Palabras cortas que solo cuentan como palabra entera del nombre (`pin`,
 * `softwarePin`, `pin_hash`, `db_pass`), para no censurar `shipping`, `mapping`
 * ni `compass`.
 */
const PALABRAS_SENSIBLES = new Set(['pin', 'p12', 'pfx', 'pass', 'pwd']);

/**
 * Claves cuyo valor suele llevar espacios o un esquema delante
 * (`Authorization: Digest a="1", b="2"`, `Cookie: a=1; b=2`): se censura hasta
 * el fin de línea.
 */
const HASTA_FIN_DE_LINEA = ['authorization', 'cookie'];

/** `contraseña` → `contrasena`, `técnica` → `tecnica`. */
function sinTildes(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizar(clave: string): string {
  return sinTildes(clave).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Parte `softwarePin`, `pin_hash` o `CERT-P12` en palabras en minúscula. */
function palabras(clave: string): string[] {
  return sinTildes(clave)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function esClaveSensible(clave: string): boolean {
  const normal = normalizar(clave);
  if (SUBCADENAS_SENSIBLES.some((s) => normal.includes(s))) return true;
  return palabras(clave).some((p) => PALABRAS_SENSIBLES.has(p));
}

/** Texto más largo que se revisa; lo que pasa de ahí se descarta, no se deja sin filtrar. */
export const MAX_TEXTO = 10_000;

/**
 * Una clave seguida de `:` o `=`. La clave es un token genérico acotado a 64
 * caracteres, sin cuantificadores alrededor de una palabra fija: así el costo
 * es lineal (un patrón como `\w*pin\w*` explotaba con `'pin'.repeat(n)`). Si es
 * sensible lo decide `esClaveSensible`, no la regex. Acepta comillas simples,
 * dobles y escapadas (`{\"pin\":\"1234\"}`, JSON dentro de JSON).
 */
const RE_CLAVE = /(\\?["'])?([A-Za-z0-9_\-ñÑáéíóúÁÉÍÓÚ]{1,64})(\\?["'])?([ \t]{0,8}[:=][ \t]{0,8})/g;

/** Esquema de autenticación delante del token (`Bearer abc`): se censura con él. */
const RE_ESQUEMA = /^(?:bearer|basic|token|digest)[ \t]+/i;

/** Corta un valor sin comillas: espacio, comilla, `&`, `}`, `]` o barra invertida. */
const RE_FIN_SIN_COMILLAS = /[\s"'&}\]\\]/;

/**
 * Índice donde termina el valor que empieza en `desde`. Entre comillas, hasta
 * la de cierre respetando escapes; sin comillas, hasta `RE_FIN_SIN_COMILLAS`
 * (una coma o un punto y coma no lo cortan: pueden ser parte de la contraseña).
 */
function finDelValor(texto: string, desde: number, clave: string): number {
  const normal = normalizar(clave);
  if (HASTA_FIN_DE_LINEA.some((c) => normal.includes(c))) {
    const salto = texto.slice(desde).search(/[\r\n]/);
    return salto < 0 ? texto.length : desde + salto;
  }
  // Comilla escapada (`\"`): el valor termina en la siguiente `\"`.
  const siguiente = texto[desde + 1];
  if (texto[desde] === '\\' && (siguiente === '"' || siguiente === "'")) {
    const cierre = texto.indexOf(`\\${siguiente}`, desde + 2);
    return cierre < 0 ? texto.length : cierre + 2;
  }
  const comilla = texto[desde];
  if (comilla === '"' || comilla === "'") {
    let i = desde + 1;
    while (i < texto.length) {
      if (texto[i] === '\\') i += 2;
      else if (texto[i] === comilla) return i + 1;
      else i += 1;
    }
    return texto.length;
  }
  let i = desde;
  const esquema = RE_ESQUEMA.exec(texto.slice(desde, desde + 16));
  if (esquema) i += esquema[0].length;
  while (i < texto.length && !RE_FIN_SIN_COMILLAS.test(texto[i] ?? '')) i += 1;
  return i;
}

/** El valor censurado conserva sus comillas, para que el JSON siga legible. */
function valorCensurado(original: string): string {
  const escapada = original.startsWith('\\"') || original.startsWith("\\'");
  const q = escapada ? original.slice(0, 2) : original[0];
  if (escapada || q === '"' || q === "'") {
    const cerrada = original.length >= 2 * (q?.length ?? 1) && original.endsWith(q ?? '');
    return `${q}${REDACTADO}${cerrada ? q : ''}`;
  }
  return REDACTADO;
}

/**
 * Censura los pares `clave=valor`, `clave: valor` y `"clave":"valor"`
 * sensibles de un texto libre. Lineal en el largo del texto, que se recorta a
 * `MAX_TEXTO` caracteres.
 */
export function redactarTexto(entrada: string): string {
  const texto = entrada.length > MAX_TEXTO ? `${entrada.slice(0, MAX_TEXTO)}…[recortado]` : entrada;
  const re = new RegExp(RE_CLAVE.source, 'g');
  let salida = '';
  let copiadoHasta = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const clave = m[2] ?? '';
    if (!esClaveSensible(clave)) continue;
    const inicioValor = m.index + m[0].length;
    const fin = finDelValor(texto, inicioValor, clave);
    if (fin === inicioValor) continue;
    salida += texto.slice(copiadoHasta, inicioValor) + valorCensurado(texto.slice(inicioValor, fin));
    copiadoHasta = fin;
    re.lastIndex = fin;
  }
  return salida + texto.slice(copiadoHasta);
}

const PROFUNDIDAD_MAX = 8;

/**
 * Copia el valor con los secretos censurados: campos de nombre sensible, todo
 * objeto con forma de secreto cifrado (`{ iv, tag, data, v }`), buffers (un .p12
 * en memoria) y pares `clave=valor` dentro de textos. No muta el original.
 */
export function redactar(valor: unknown, profundidad = 0, vistos = new WeakSet<object>()): unknown {
  if (typeof valor === 'string') return redactarTexto(valor);
  if (valor === null || typeof valor !== 'object') return valor;
  if (Buffer.isBuffer(valor) || ArrayBuffer.isView(valor)) return REDACTADO;
  if (esSecretoCifrado(valor)) return REDACTADO;
  if (vistos.has(valor)) return '[circular]';
  if (!(valor instanceof Error) && !Array.isArray(valor)) {
    // Documentos de Mongoose, ObjectId, Date…: se recorre su forma serializada
    // (la de un documento ya sale sin los campos secretos, ver `secretos.ts`).
    const serializable = valor as { toJSON?: () => unknown; toObject?: () => unknown };
    const convertir = serializable.toJSON ?? serializable.toObject;
    if (typeof convertir === 'function') {
      vistos.add(valor);
      return redactar(convertir.call(valor), profundidad + 1, vistos);
    }
  }
  if (profundidad >= PROFUNDIDAD_MAX) return '[profundo]';
  vistos.add(valor);

  if (Array.isArray(valor)) return valor.map((v) => redactar(v, profundidad + 1, vistos));

  if (valor instanceof Error) {
    // Se conserva como Error para que el logger siga imprimiendo la pila.
    const copia = new Error(redactarTexto(valor.message));
    copia.name = valor.name;
    if (valor.stack) copia.stack = redactarTexto(valor.stack);
    // `cause` es ES2022 y el tsconfig apunta más atrás: se toca como propiedad suelta.
    const causa = (valor as { cause?: unknown }).cause;
    if (causa !== undefined) {
      (copia as { cause?: unknown }).cause = redactar(causa, profundidad + 1, vistos);
    }
    return copia;
  }

  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor)) {
    salida[clave] = esClaveSensible(clave) ? REDACTADO : redactar(v, profundidad + 1, vistos);
  }
  return salida;
}

/**
 * Logger de Nest con el filtro aplicado a cada mensaje y parámetro. Se instala
 * en `main.ts` para la app y para los `new Logger(...)` sueltos.
 */
export class LoggerSeguro extends ConsoleLogger {
  override log(mensaje: unknown, ...resto: unknown[]): void {
    super.log(registrable(mensaje), ...resto.map(registrable));
  }
  override error(mensaje: unknown, ...resto: unknown[]): void {
    super.error(registrable(mensaje), ...resto.map(registrable));
  }
  override warn(mensaje: unknown, ...resto: unknown[]): void {
    super.warn(registrable(mensaje), ...resto.map(registrable));
  }
  override debug(mensaje: unknown, ...resto: unknown[]): void {
    super.debug(registrable(mensaje), ...resto.map(registrable));
  }
  override verbose(mensaje: unknown, ...resto: unknown[]): void {
    super.verbose(registrable(mensaje), ...resto.map(registrable));
  }
  override fatal(mensaje: unknown, ...resto: unknown[]): void {
    super.fatal(registrable(mensaje), ...resto.map(registrable));
  }
}

export const NO_REGISTRABLE = '[no-registrable]';

/**
 * `redactar` sin riesgo para quien loguea: un getter que lanza o un `toJSON`
 * roto no pueden tumbar la petición, y ante la duda el valor no se imprime.
 */
export function registrable(valor: unknown): unknown {
  try {
    return redactar(valor);
  } catch {
    return NO_REGISTRABLE;
  }
}
