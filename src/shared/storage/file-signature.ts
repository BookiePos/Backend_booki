import { BadRequestException } from '@nestjs/common';

/**
 * Validación de subidas por CONTENIDO (bytes mágicos), no por el `mimetype`
 * que declara el cliente. El mimetype lo escribe quien sube el archivo: un HTML
 * con `image/png` o un PNG renombrado a `.pdf` pasarían una validación por
 * cabecera y acabarían en el bucket público.
 *
 * Sin dependencias: `file-type` es ESM puro y no se resuelve limpio desde el
 * build CommonJS; las firmas que aceptamos caben en pocas líneas.
 * SVG no se detecta a propósito: es un documento con scripts.
 */

export interface DetectedFileType {
  mime: string;
  ext: string;
}

/** Imágenes que aceptan las fotos de producto y las facturas escaneadas. */
export const IMAGE_MIMES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
];

const starts = (b: Buffer, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/** Tipo real del archivo según sus primeros bytes, o `null` si no es uno conocido. */
export function detectFileType(buf: Buffer): DetectedFileType | null {
  if (starts(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', ext: 'png' };
  }
  // RIFF....WEBP
  if (starts(buf, [0x52, 0x49, 0x46, 0x46]) && starts(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  // PDF: %PDF-
  if (starts(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { mime: 'application/pdf', ext: 'pdf' };
  }
  // AVIF: caja ISO-BMFF `ftyp` con marca avif/avis en la posición 8.
  if (starts(buf, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}

/**
 * Exige que el contenido sea uno de `allowed`. Devuelve el tipo DETECTADO, que
 * es el que hay que usar como extensión y como Content-Type al guardar.
 */
export function validateUploadedFile(
  buf: Buffer,
  allowed: readonly string[],
  label: string,
): DetectedFileType {
  const detected = detectFileType(buf);
  if (!detected || !allowed.includes(detected.mime)) {
    throw new BadRequestException(
      `El contenido del archivo no es un formato admitido. Usa ${label}.`,
    );
  }
  return detected;
}
