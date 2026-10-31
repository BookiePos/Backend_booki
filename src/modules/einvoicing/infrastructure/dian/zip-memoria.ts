import { deflateRawSync } from 'zlib';

/**
 * ZIP mínimo en memoria (deflate): una entrada para la DIAN (`contentFile`) o
 * varias para la entrega al adquiriente. Sin dependencias: cabecera local, directorio central y
 * fin de directorio (APPNOTE 6.3.x §4.3), con nombres en UTF-8 (bit 11).
 */

const TABLA_CRC = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), el que exige el formato ZIP. */
export function crc32(datos: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < datos.length; i++) c = TABLA_CRC[(c ^ datos[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fecha y hora en formato MS-DOS (resolución de 2 s, años 1980-2107). */
function fechaDos(d: Date): { hora: number; fecha: number } {
  const anio = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    hora: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    fecha: ((anio - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const FLAG_UTF8 = 0x0800;
const METODO_DEFLATE = 8;
const VERSION = 20;

export interface EntradaZip {
  nombre: string;
  contenido: Buffer | string;
}

function nombreValido(nombre: string): boolean {
  return Boolean(nombre) && !nombre.includes('/') && !nombre.includes('\\');
}

/** Arma un ZIP con un único archivo (el `contentFile` que recibe la DIAN). */
export function zipUnArchivo(nombre: string, contenido: Buffer | string, ahora = new Date()): Buffer {
  return zipArchivos([{ nombre, contenido }], ahora);
}

/**
 * Arma un ZIP con varias entradas en la raíz (p. ej. la entrega al adquiriente:
 * AttachedDocument + PDF). Nombres sin ruta y sin repetir.
 */
export function zipArchivos(entradas: readonly EntradaZip[], ahora = new Date()): Buffer {
  if (entradas.length === 0 || entradas.length > 0xffff) throw new Error('El ZIP necesita al menos un archivo');
  const vistos = new Set<string>();
  for (const e of entradas) {
    if (!nombreValido(e.nombre)) throw new Error('Nombre de archivo inválido para el ZIP');
    if (vistos.has(e.nombre)) throw new Error('Nombre de archivo repetido en el ZIP');
    vistos.add(e.nombre);
  }
  const { hora, fecha } = fechaDos(ahora);
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let desplazamiento = 0;

  for (const e of entradas) {
    const datos = typeof e.contenido === 'string' ? Buffer.from(e.contenido, 'utf8') : e.contenido;
    const comprimido = deflateRawSync(datos);
    const nombreB = Buffer.from(e.nombre, 'utf8');
    const crc = crc32(datos);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METODO_DEFLATE, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(fecha, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombreB.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METODO_DEFLATE, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(fecha, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nombreB.length, 28);
    // extra, comentario, disco, atributos internos y externos: 0.
    central.writeUInt32LE(desplazamiento, 42); // desplazamiento de la cabecera local

    locales.push(local, nombreB, comprimido);
    centrales.push(central, nombreB);
    desplazamiento += local.length + nombreB.length + comprimido.length;
  }

  const tamCentral = centrales.reduce((n, b) => n + b.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(tamCentral, 12);
  fin.writeUInt32LE(desplazamiento, 16);

  return Buffer.concat([...locales, ...centrales, fin]);
}
