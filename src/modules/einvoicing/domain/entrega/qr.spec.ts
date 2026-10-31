import { describe, expect, it } from 'vitest';
import { generarQrMatrix } from './qr';

/**
 * El encoder se validó además contra un decodificador real (jsQR) con la URL del
 * catálogo de la DIAN en los cuatro niveles; aquí se fija la estructura que
 * cualquier lector necesita: tamaño, patrones de posición, sincronismo y la
 * información de formato con su BCH.
 */

const URL_QR =
  'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=' +
  '8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4';

function finderEn(m: boolean[][], x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const borde = dx === 0 || dx === 6 || dy === 0 || dy === 6;
      const centro = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      if (m[y0 + dy]![x0 + dx] !== (borde || centro)) return false;
    }
  }
  return true;
}

/** Los 15 bits de formato de la copia alrededor del finder superior izquierdo. */
function formato(m: boolean[][]): number {
  const bits: boolean[] = [];
  for (let i = 0; i <= 5; i += 1) bits.push(m[i]![8]!);
  bits.push(m[7]![8]!, m[8]![8]!, m[8]![7]!);
  for (let i = 9; i < 15; i += 1) bits.push(m[8]![14 - i]!);
  return bits.reduce((n, b, i) => n | (Number(b) << i), 0);
}

describe('QR de la representación gráfica', () => {
  it('la URL del catálogo con un CUFE de 96 caracteres cabe en la versión 9 (M)', () => {
    const m = generarQrMatrix(URL_QR, 'M');
    expect(m.length).toBe(9 * 4 + 17);
    expect(m.every((fila) => fila.length === m.length)).toBe(true);
  });

  it('tiene los tres patrones de posición y el sincronismo', () => {
    const m = generarQrMatrix(URL_QR);
    const n = m.length;
    expect(finderEn(m, 0, 0)).toBe(true);
    expect(finderEn(m, n - 7, 0)).toBe(true);
    expect(finderEn(m, 0, n - 7)).toBe(true);
    for (let i = 8; i < n - 8; i += 1) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]![8]).toBe(true); // módulo oscuro fijo
  });

  it('la información de formato declara el nivel M y pasa el BCH', () => {
    const bits = formato(generarQrMatrix(URL_QR, 'M')) ^ 0x5412;
    const datos = bits >>> 10;
    let rem = datos;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(((datos << 10) | (rem & 0x3ff)) === bits).toBe(true);
    expect(datos >>> 3).toBe(0); // M = 00
  });

  it('es determinista', () => {
    expect(generarQrMatrix(URL_QR)).toEqual(generarQrMatrix(URL_QR));
  });

  it('rechaza un contenido que no cabe en la versión 40', () => {
    expect(() => generarQrMatrix('x'.repeat(4000), 'H')).toThrow();
  });
});
