import { crc32 as crc32Node, inflateRawSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { crc32, zipUnArchivo } from './zip-memoria';

/** Lector mínimo e independiente: va por el directorio central, como un unzip real. */
function leerZip(zip: Buffer): { nombre: string; datos: Buffer; crc: number; metodo: number } {
  const fin = zip.length - 22;
  expect(zip.readUInt32LE(fin)).toBe(0x06054b50);
  expect(zip.readUInt16LE(fin + 10)).toBe(1);
  const cd = zip.readUInt32LE(fin + 16);
  expect(zip.readUInt32LE(cd)).toBe(0x02014b50);
  const metodo = zip.readUInt16LE(cd + 10);
  const crc = zip.readUInt32LE(cd + 16);
  const comp = zip.readUInt32LE(cd + 20);
  const tam = zip.readUInt32LE(cd + 24);
  const largoNombre = zip.readUInt16LE(cd + 28);
  const nombre = zip.subarray(cd + 46, cd + 46 + largoNombre).toString('utf8');
  const local = zip.readUInt32LE(cd + 42);
  expect(zip.readUInt32LE(local)).toBe(0x04034b50);
  expect(zip.readUInt32LE(local + 14)).toBe(crc);
  const ini = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const datos = inflateRawSync(zip.subarray(ini, ini + comp));
  expect(datos.length).toBe(tam);
  return { nombre, datos, crc, metodo };
}

describe('zip en memoria', () => {
  it('CRC-32 da el valor de control estándar', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const b = Buffer.from('<Invoice>ñandú</Invoice>');
    expect(crc32(b)).toBe(crc32Node(b));
  });

  it('el ZIP se descomprime al contenido original con su CRC correcto', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Invoice>${'línea '.repeat(500)}</Invoice>`;
    const zip = zipUnArchivo('fv09001234560002600000001.xml', xml, new Date('2026-10-30T15:04:06Z'));
    const e = leerZip(zip);
    expect(e.nombre).toBe('fv09001234560002600000001.xml');
    expect(e.metodo).toBe(8);
    expect(e.datos.toString('utf8')).toBe(xml);
    expect(e.crc).toBe(crc32Node(Buffer.from(xml, 'utf8')));
  });

  it('rechaza nombres con ruta', () => {
    expect(() => zipUnArchivo('../x.xml', 'a')).toThrow();
    expect(() => zipUnArchivo('', 'a')).toThrow();
  });
});
