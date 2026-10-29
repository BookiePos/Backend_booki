import { createHash } from 'crypto';
import { TIPO_AMBIENTE } from './einvoicing.constants';
import { TIPO_AMBIENTE_POR_DEFECTO, type TipoAmbiente } from './emisor-fiscal';
import {
  aCentavos,
  formatearMontoDian,
  type Centavos,
  type ImpuestosCentavos,
} from './redondeo';

/**
 * CUFE y CUDE de la DIAN: SHA-384 de una concatenación en orden estricto.
 *
 * Anexo técnico de la factura electrónica de venta v1.9 (Res. 000165 de 2023),
 * §11.1.2 (CUFE) y §11.1.4 (CUDE):
 *
 *   NumFac + FecFac + HorFac + ValFac + 01 + ValImp1 + 04 + ValImp2 + 03 +
 *   ValImp3 + ValTot + NitOFE + NumAdq + (ClTec | Software-PIN) + TipoAmbiente
 *
 * Los tres pares de impuesto van SIEMPRE, en ese orden (IVA, INC, ICA), con
 * `0.00` cuando el impuesto no aplica. La DIAN recalcula el código con los
 * valores del XML (LegalMonetaryTotal, TaxTotal por código y ProfileExecutionID),
 * así que los montos deben salir de `totalesDesdeLineas` (ver `redondeo.ts`).
 *
 * - Factura (FEV): llave = clave técnica de la resolución.
 * - Notas crédito/débito y documento de contingencia: llave = PIN del software.
 * - Documento equivalente electrónico POS (anexo DE v1.0, Res. 000165 de 2023,
 *   §14.1.2): la misma fórmula, con el PIN del software (`SfPin`).
 */

/** Los campos comunes al CUFE y a los CUDE. Montos en centavos. */
export interface DatosCodigoUnico {
  /** Prefijo + consecutivo (cbc:ID). */
  numero: string;
  /** YYYY-MM-DD (cbc:IssueDate). */
  fecha: string;
  /** HH:MM:SS-05:00 (cbc:IssueTime). */
  hora: string;
  /** LineExtensionAmount: suma de las bases, sin impuestos. */
  valorBruto: Centavos;
  /** TaxTotal por código: 01 IVA, 04 INC, 03 ICA. */
  impuestos: ImpuestosCentavos;
  /** PayableAmount. */
  valorTotal: Centavos;
  /** NIT del emisor, solo dígitos y sin DV. */
  nitEmisor: string;
  /** Documento del adquiriente, sin puntos ni guiones ni DV (consumidor final: 222222222222). */
  numAdquiriente: string;
  /** 1 producción, 2 habilitación. Sale del emisor fiscal, no de una constante. */
  tipoAmbiente: TipoAmbiente;
}

function assertSoloDigitos(valor: string, que: string): void {
  if (!/^\d+$/.test(valor)) {
    throw new Error(`${que} va solo con dígitos, sin puntos, guiones ni DV: «${valor}»`);
  }
}

/** Formato de cbc:IssueDate / cbc:IssueTime que entra en el hash (hora de Colombia, GMT-5). */
export const FORMATO_FECHA_DIAN = /^\d{4}-\d{2}-\d{2}$/;
export const FORMATO_HORA_DIAN = /^\d{2}:\d{2}:\d{2}-05:00$/;

export function assertFechaHoraDian(fecha: string, hora: string): void {
  if (!FORMATO_FECHA_DIAN.test(fecha)) throw new Error(`Fecha inválida para la DIAN: «${fecha}» (AAAA-MM-DD)`);
  if (!FORMATO_HORA_DIAN.test(hora)) throw new Error(`Hora inválida para la DIAN: «${hora}» (HH:MM:SS-05:00)`);
}

function assertAmbiente(t: string): void {
  if (t !== '1' && t !== '2') throw new Error(`Tipo de ambiente inválido: «${t}» (1 producción, 2 habilitación)`);
}

function cadena(d: DatosCodigoUnico, llave: string, queLlave: string): string {
  if (!llave.trim()) throw new Error(`Falta ${queLlave}: sin ella el código no es válido ante la DIAN.`);
  assertSoloDigitos(d.nitEmisor, 'El NIT del emisor');
  assertFechaHoraDian(d.fecha, d.hora);
  assertAmbiente(d.tipoAmbiente);
  return componer(d, llave);
}

/** La concatenación pura, sin validar (la valida `cadena`). */
function componer(d: DatosCodigoUnico, llave: string): string {
  return (
    d.numero +
    d.fecha +
    d.hora +
    formatearMontoDian(d.valorBruto) +
    '01' +
    formatearMontoDian(d.impuestos['01']) +
    '04' +
    formatearMontoDian(d.impuestos['04']) +
    '03' +
    formatearMontoDian(d.impuestos['03']) +
    formatearMontoDian(d.valorTotal) +
    d.nitEmisor +
    d.numAdquiriente +
    llave +
    d.tipoAmbiente
  );
}

function sha384(s: string): string {
  return createHash('sha384').update(s, 'utf8').digest('hex');
}

/** La cadena del CUFE, separada para poder compararla con la composición del anexo. */
export function cadenaCufe(d: DatosCodigoUnico & { claveTecnica: string }): string {
  return cadena(d, d.claveTecnica, 'la clave técnica de la resolución');
}

/** CUFE de la factura electrónica de venta (anexo FEV 1.9, §11.1.2). */
export function calcularCufe(d: DatosCodigoUnico & { claveTecnica: string }): string {
  return sha384(cadenaCufe(d));
}

/**
 * La cadena del CUDE: la del CUFE con el PIN del software en lugar de la clave
 * técnica. A propósito no acepta `claveTecnica`: la DIAN recalcula el CUDE con el
 * PIN y rechaza la nota que se haya calculado con la clave de la resolución.
 */
export function cadenaCude(d: DatosCodigoUnico & { softwarePin: string }): string {
  return cadena(d, d.softwarePin, 'el PIN del software');
}

/** CUDE de una nota crédito o débito (anexo FEV 1.9, §11.1.4). */
export function calcularCude(d: DatosCodigoUnico & { softwarePin: string }): string {
  return sha384(cadenaCude(d));
}

/**
 * CUDE del documento equivalente electrónico tiquete POS (anexo DE v1.0,
 * §14.1.2-14.1.4): la misma composición que el CUDE de las notas, con los
 * valores del POS (ProfileExecutionID para el ambiente). Función propia para que
 * quien emite el POS no tenga que saber que coinciden.
 */
export function calcularCudePos(d: DatosCodigoUnico & { softwarePin: string }): string {
  return calcularCude(d);
}

/** Catálogo de consulta de la DIAN por ambiente (anexo FEV 1.9 §11.1.7.1; anexo DE v1.0, DEAB36). */
export const URL_CATALOGO_DIAN: Record<TipoAmbiente, string> = {
  '1': 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=',
  '2': 'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=',
};

/**
 * URL pública de verificación (contenido del QR) para un CUFE, CUDE o CUNE. El
 * ambiente decide el catálogo: habilitación (2) consulta `catalogo-vpfe-hab`.
 * El valor por defecto existe solo para el llamador antiguo; el nuevo pasa el
 * ambiente del emisor.
 */
export function dianVerificationUrl(
  codigo: string,
  tipoAmbiente: TipoAmbiente = TIPO_AMBIENTE_POR_DEFECTO,
): string {
  assertAmbiente(tipoAmbiente);
  return `${URL_CATALOGO_DIAN[tipoAmbiente]}${codigo}`;
}

/**
 * @deprecated Firma antigua: mete todo el impuesto como IVA, deja INC e ICA en
 * 0 y usa la constante `TIPO_AMBIENTE`. Se conserva solo para que
 * `einvoicing.service.ts` siga compilando hasta que lo conecten a
 * `calcularCufe` / `calcularCude`. No la uses en código nuevo.
 */
export function computeCufe(input: {
  numFac: string;
  fecFac: string;
  horFac: string;
  valFac: number;
  valIva: number;
  valTot: number;
  nitOFE: string;
  numAdq: string;
  claveTecnica: string;
}): string {
  // Sin las validaciones nuevas (NIT solo dígitos, etc.): el llamador antiguo no
  // las cumple siempre y esta ruta no debe empezar a lanzar antes de conectarla.
  const datos: DatosCodigoUnico = {
    numero: input.numFac,
    fecha: input.fecFac,
    hora: input.horFac,
    valorBruto: aCentavos(input.valFac),
    impuestos: { '01': aCentavos(input.valIva), '04': 0, '03': 0 },
    valorTotal: aCentavos(input.valTot),
    nitEmisor: input.nitOFE,
    numAdquiriente: input.numAdq,
    tipoAmbiente: TIPO_AMBIENTE,
  };
  return sha384(componer(datos, input.claveTecnica));
}
