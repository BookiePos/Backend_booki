/**
 * Código QR (ISO/IEC 18004) sin dependencias, para la representación gráfica de
 * la factura electrónica (Fase 5B): el QR lleva la URL de consulta del CUFE en
 * el catálogo de la DIAN (`dianVerificationUrl`).
 *
 * Modo byte (UTF-8), niveles L/M/Q/H y versión automática (1-40). Devuelve la
 * matriz de módulos (`true` = oscuro); quien dibuja decide el tamaño. Pura y
 * determinista.
 *
 * Portado de la referencia de AlíaCorp (`apps/erp/lib/dian/qr.ts`), basada en el
 * algoritmo de Nayuki (QR Code generator, MIT). Sin Nest ni Mongoose.
 */

const MIN_VERSION = 1;
const MAX_VERSION = 40;
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

interface EccConst {
  ordinal: number;
  formatBits: number;
}

const ECC: Record<EccLevel, EccConst> = {
  L: { ordinal: 0, formatBits: 1 },
  M: { ordinal: 1, formatBits: 0 },
  Q: { ordinal: 2, formatBits: 3 },
  H: { ordinal: 3, formatBits: 2 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tablas del estándar (ECC codewords por bloque + cantidad de bloques por versión
// y nivel) y total de codewords por versión.
// ─────────────────────────────────────────────────────────────────────────────
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  // index por ECC ordinal (L,M,Q,H); columna 0 sin usar (versión arranca en 1).
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];

const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19,
    19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
    33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43,
    45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
    51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

/**
 * Genera la matriz de módulos del QR para `text` (modo byte UTF-8).
 * @returns matriz `boolean[size][size]` (true = módulo oscuro).
 */
export function generarQrMatrix(text: string, ecc: EccLevel = 'M'): boolean[][] {
  const data = utf8Bytes(text);
  const version = pickVersion(data.length, ecc);
  return new QrEncoder(version, ecc, data).render();
}

/** Codifica un string a bytes UTF-8 sin depender de TextEncoder. */
function utf8Bytes(text: string): number[] {
  return Array.from(Buffer.from(text, 'utf8'));
}

/** Selecciona la versión más pequeña que alberga `numBytes` en modo byte + ECC. */
function pickVersion(numBytes: number, ecc: EccLevel): number {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const capacityBits = numDataCodewords(v, ecc) * 8;
    const charCountBits = v >= 10 ? 16 : 8; // byte mode count indicator
    const usedBits = 4 + charCountBits + numBytes * 8;
    if (usedBits <= capacityBits) return v;
  }
  throw new Error('El contenido del QR excede la capacidad máxima (versión 40).');
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number, ecc: EccLevel): number {
  const ord = ECC[ecc].ordinal;
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ord]![version]! * NUM_ERROR_CORRECTION_BLOCKS[ord]![version]!
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reed-Solomon sobre GF(256).
// ─────────────────────────────────────────────────────────────────────────────
function reedSolomonComputeDivisor(degree: number): number[] {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j] ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i]!, factor);
  }
  return result;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoder principal (build de codewords + matriz + máscara óptima).
// ─────────────────────────────────────────────────────────────────────────────
class QrEncoder {
  private readonly size: number;
  private readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(
    private readonly version: number,
    private readonly ecc: EccLevel,
    dataBytes: number[],
  ) {
    this.size = version * 4 + 17;
    this.modules = QrEncoder.grid(this.size);
    this.isFunction = QrEncoder.grid(this.size);

    const codewords = this.buildCodewords(dataBytes);
    this.drawFunctionPatterns();
    this.drawCodewords(codewords);
    this.applyBestMask();
  }

  render(): boolean[][] {
    return this.modules.map((row) => row.slice());
  }

  private static grid(size: number): boolean[][] {
    return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  private buildCodewords(dataBytes: number[]): number[] {
    const ord = ECC[this.ecc].ordinal;
    const totalDataCw = numDataCodewords(this.version, this.ecc);

    // 1. Bitstream: mode (byte=0100) + char count + data + terminator + padding.
    const bits: number[] = [];
    appendBits(bits, 0x4, 4);
    const charCountBits = this.version >= 10 ? 16 : 8;
    appendBits(bits, dataBytes.length, charCountBits);
    for (const b of dataBytes) appendBits(bits, b, 8);

    const capacityBits = totalDataCw * 8;
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
    while (bits.length % 8 !== 0) bits.push(0); // byte align

    // Pad bytes alternados 0xEC / 0x11.
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);

    // Bits → data codewords.
    const dataCw: number[] = new Array(bits.length / 8).fill(0);
    for (let i = 0; i < bits.length; i++) dataCw[i >>> 3]! |= bits[i]! << (7 - (i & 7));

    // 2. Reed-Solomon por bloque + interleaving.
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ord]![this.version]!;
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ord]![this.version]!;
    const rawCw = Math.floor(numRawDataModules(this.version) / 8);
    const numShortBlocks = numBlocks - (rawCw % numBlocks);
    const shortBlockDataLen = Math.floor(rawCw / numBlocks) - blockEccLen;

    const blocks: number[][] = [];
    const rsDiv = reedSolomonComputeDivisor(blockEccLen);
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
      const dataLen = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
      const dat = dataCw.slice(k, k + dataLen);
      k += dataLen;
      const eccPart = reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0); // pad column for interleave
      blocks.push(dat.concat(eccPart));
    }

    // Interleave: columna a columna.
    const result: number[] = [];
    for (let col = 0; col < blocks[0]!.length; col++) {
      for (let row = 0; row < blocks.length; row++) {
        // Saltar la columna de padding de los bloques cortos en la sección de datos.
        if (col !== shortBlockDataLen || row >= numShortBlocks) result.push(blocks[row]![col]!);
      }
    }
    return result;
  }

  // ── Patrones de función ────────────────────────────────────────────────────
  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    const alignPos = this.alignmentPatternPositions();
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        this.drawAlignmentPattern(alignPos[i]!, alignPos[j]!);
      }
    }

    this.drawFormatBits(0); // placeholder; real mask se aplica luego.
    this.drawVersion();
  }

  private drawFinderPattern(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignmentPattern(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private alignmentPatternPositions(): number[] {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result: number[] = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  private drawFormatBits(mask: number): void {
    const data = (ECC[this.ecc].formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, getBit(bits, i));
    this.setFunction(8, this.size - 8, true); // dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  // ── Data + ECC en zig-zag ────────────────────────────────────────────────
  private drawCodewords(codewords: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = getBit(codewords[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  // ── Máscara óptima (prueba las 8, minimiza penalización) ──────────────────
  private applyBestMask(): void {
    let bestMask = 0;
    let minPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask);
      this.drawFormatBits(mask);
      const penalty = this.penaltyScore();
      if (penalty < minPenalty) {
        minPenalty = penalty;
        bestMask = mask;
      }
      this.applyMask(mask); // undo (XOR es su propio inverso)
    }
    this.applyMask(bestMask);
    this.drawFormatBits(bestMask);
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y]![x]) continue;
        let invert = false;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          case 7:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  private penaltyScore(): number {
    let result = 0;
    const size = this.size;

    // N1 — runs de 5+ del mismo color en filas y columnas.
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runLen = 0;
      for (let x = 0; x < size; x++) {
        if (this.modules[y]![x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          runColor = this.modules[y]![x]!;
          runLen = 1;
        }
      }
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runLen = 0;
      for (let y = 0; y < size; y++) {
        if (this.modules[y]![x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          runColor = this.modules[y]![x]!;
          runLen = 1;
        }
      }
    }

    // N2 — bloques 2x2 del mismo color.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y]![x];
        if (c === this.modules[y]![x + 1] && c === this.modules[y + 1]![x] && c === this.modules[y + 1]![x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // N3 — patrón finder-like (1:1:3:1:1) en filas y columnas.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (x <= size - 11 && this.matchFinder(x, y, true)) result += PENALTY_N3;
        if (y <= size - 11 && this.matchFinder(x, y, false)) result += PENALTY_N3;
      }
    }

    // N4 — desviación de la proporción 50% de módulos oscuros.
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (this.modules[y]![x]) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += Math.max(k, 0) * PENALTY_N4;

    return result;
  }

  private matchFinder(x: number, y: number, horizontal: boolean): boolean {
    const at = (i: number): boolean => (horizontal ? this.modules[y]![x + i]! : this.modules[y + i]![x]!);
    // patrón: 1011101 0000 (dark,light,dark*3,light,dark + 4 light) — aprox finder.
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i < 7; i++) if (at(i) !== pattern[i]) return false;
    // 4 módulos claros a un lado.
    if (horizontal) {
      if (x + 10 < this.size) {
        for (let i = 7; i < 11; i++) if (at(i)) return false;
        return true;
      }
      return false;
    } else {
      if (y + 10 < this.size) {
        for (let i = 7; i < 11; i++) if (at(i)) return false;
        return true;
      }
      return false;
    }
  }
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}
