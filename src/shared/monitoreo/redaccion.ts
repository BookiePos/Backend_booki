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
  'contrasena',
  'clavetecnica',
  'certificado',
  'secret',
  'privatekey',
  'llaveprivada',
  'token',
  'authorization',
  'cookie',
];

/**
 * Palabras cortas que solo cuentan como palabra entera del nombre (`pin`,
 * `softwarePin`, `pin_hash`), para no censurar `shipping` ni `mapping`.
 */
const PALABRAS_SENSIBLES = new Set(['pin', 'p12', 'pfx']);

/** `contraseña` → `contrasena`, `técnica` → `tecnica`. */
function sinTildes(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
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
  const normal = sinTildes(clave).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SUBCADENAS_SENSIBLES.some((s) => normal.includes(s))) return true;
  return palabras(clave).some((p) => PALABRAS_SENSIBLES.has(p));
}

/**
 * `clave=valor`, `clave: valor` y `"clave":"valor"` dentro de un texto libre.
 * El valor llega hasta el siguiente espacio, coma, punto y coma, comilla o `&`.
 */
const RE_PAR_EN_TEXTO = new RegExp(
  String.raw`(["']?)([A-Za-z0-9_\-]*(?:password|contrase(?:ñ|n)a|pin|clave_?t[eé]cnica|p12|pfx|certificado|secret|private_?key|llave_?privada|token|authorization)[A-Za-z0-9_\-]*)\1(\s*[:=]\s*)(["']?)([^\s"',;&}]+)`,
  'gi',
);

/** Censura los pares `clave=valor` sensibles que aparezcan en un texto. */
export function redactarTexto(texto: string): string {
  return texto.replace(RE_PAR_EN_TEXTO, (todo, q1: string, clave: string, sep: string, q2: string) =>
    esClaveSensible(clave) ? `${q1}${clave}${q1}${sep}${q2}${REDACTADO}` : todo,
  );
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
  if (profundidad >= PROFUNDIDAD_MAX) return '[profundo]';
  vistos.add(valor);

  if (Array.isArray(valor)) return valor.map((v) => redactar(v, profundidad + 1, vistos));

  if (valor instanceof Error) {
    // Se conserva como Error para que el logger siga imprimiendo la pila.
    const copia = new Error(redactarTexto(valor.message));
    copia.name = valor.name;
    if (valor.stack) copia.stack = redactarTexto(valor.stack);
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
    super.log(redactar(mensaje), ...resto.map((r) => redactar(r)));
  }
  override error(mensaje: unknown, ...resto: unknown[]): void {
    super.error(redactar(mensaje), ...resto.map((r) => redactar(r)));
  }
  override warn(mensaje: unknown, ...resto: unknown[]): void {
    super.warn(redactar(mensaje), ...resto.map((r) => redactar(r)));
  }
  override debug(mensaje: unknown, ...resto: unknown[]): void {
    super.debug(redactar(mensaje), ...resto.map((r) => redactar(r)));
  }
  override verbose(mensaje: unknown, ...resto: unknown[]): void {
    super.verbose(redactar(mensaje), ...resto.map((r) => redactar(r)));
  }
  override fatal(mensaje: unknown, ...resto: unknown[]): void {
    super.fatal(redactar(mensaje), ...resto.map((r) => redactar(r)));
  }
}
