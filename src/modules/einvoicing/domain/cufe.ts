import { createHash } from 'crypto';
import { TIPO_AMBIENTE } from './einvoicing.constants';

/** Formatea a 2 decimales con punto, como exige el Anexo Técnico DIAN. */
function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Calcula el CUFE (Código Único de Factura Electrónica) según el Anexo Técnico
 * 1.9 de la DIAN: SHA-384 de la concatenación de campos en orden estricto.
 *
 * Orden: NumFac + FecFac + HorFac + ValFac + 01 + ValIva + 04 + ValINC + 03 +
 * ValICA + ValTot + NitOFE + NumAdq + ClTec + TipoAmbiente.
 *
 * Es el algoritmo real; el valor solo es "válido" una vez la DIAN valida el
 * documento (vía proveedor tecnológico). Sin PT queda como referencia (ambiente
 * de pruebas, `TipoAmbiente = 2`).
 */
export function computeCufe(input: {
  numFac: string;
  /** Fecha YYYY-MM-DD. */
  fecFac: string;
  /** Hora HH:MM:SS-05:00. */
  horFac: string;
  /** Valor subtotal (base gravable). */
  valFac: number;
  valIva: number;
  valTot: number;
  /** NIT del emisor (sin DV). */
  nitOFE: string;
  /** Documento del adquiriente. */
  numAdq: string;
  claveTecnica: string;
}): string {
  const raw =
    input.numFac +
    input.fecFac +
    input.horFac +
    money(input.valFac) +
    '01' +
    money(input.valIva) +
    '04' +
    money(0) +
    '03' +
    money(0) +
    money(input.valTot) +
    input.nitOFE +
    input.numAdq +
    input.claveTecnica +
    TIPO_AMBIENTE;
  return createHash('sha384').update(raw, 'utf8').digest('hex');
}

/** URL pública de verificación de la DIAN a partir del CUFE. */
export function dianVerificationUrl(cufe: string): string {
  return `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${cufe}`;
}
