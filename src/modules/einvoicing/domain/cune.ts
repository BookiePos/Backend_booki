import { createHash } from 'crypto';
import { assertFechaHoraDian } from './cufe';
import type { TipoAmbiente } from './emisor-fiscal';
import { formatearMontoDian, type Centavos } from './redondeo';

/**
 * CUNE de la nómina electrónica: anexo técnico del documento soporte de pago de
 * nómina electrónica v1.0 (Res. 000013 de 2021), §8.1.1.1:
 *
 *   SHA-384(NumNE + FecNE + HorNE + ValDev + ValDed + ValTolNE + NitNE +
 *           DocEmp + TipoXML + Software-Pin + TipAmb)
 *
 * - Valores con punto y dos decimales, sin separadores (`formatearMontoDian`).
 *   El anexo pide los decimales TRUNCADOS (no redondeados) a dos dígitos: quien
 *   llama entrega los montos ya truncados en centavos enteros. Con la nómina de
 *   BookiPos en COP entero no hay nada que truncar.
 * - NitNE y DocEmp sin puntos, guiones ni DV.
 * - Software-Pin: el PIN del software de NÓMINA, que no es el de la factura.
 * - Nota de ajuste «Eliminar» (§8.1.1.4): ValDev = ValDed = ValTol = 0.00 y DocEmp = 0.
 */

/** 102 = NominaIndividual, 103 = NominaIndividualDeAjuste. */
export type TipoXmlNomina = '102' | '103';

export interface DatosCune {
  /** Prefijo + consecutivo (NumeroSecuenciaXML/@Numero). */
  numero: string;
  /** YYYY-MM-DD (InformacionGeneral/@FechaGen). */
  fecha: string;
  /** HH:MM:SS-05:00 (InformacionGeneral/@HoraGen). */
  hora: string;
  /** DevengadosTotal, en centavos. */
  devengados: Centavos;
  /** DeduccionesTotal, en centavos. */
  deducciones: Centavos;
  /** ComprobanteTotal = devengados − deducciones, en centavos. */
  total: Centavos;
  /** NIT del empleador, solo dígitos y sin DV. */
  nitEmpleador: string;
  /** Documento del trabajador, sin puntos ni guiones. */
  docEmpleado: string;
  tipoXml: TipoXmlNomina;
  /** PIN del software de nómina electrónica. */
  softwarePin: string;
  tipoAmbiente: TipoAmbiente;
}

/** La cadena del CUNE, separada para poder compararla con la del anexo. */
export function cadenaCune(d: DatosCune): string {
  if (!d.softwarePin.trim()) {
    throw new Error('Falta el PIN del software de nómina electrónica: sin él no hay CUNE válido.');
  }
  if (!/^\d+$/.test(d.nitEmpleador)) {
    throw new Error(`El NIT del empleador va solo con dígitos, sin DV: «${d.nitEmpleador}»`);
  }
  assertFechaHoraDian(d.fecha, d.hora);
  if (d.tipoAmbiente !== '1' && d.tipoAmbiente !== '2') {
    throw new Error(`Tipo de ambiente inválido: «${d.tipoAmbiente}»`);
  }
  if (d.deducciones > d.devengados) {
    throw new Error(
      `Las deducciones de la nómina (${formatearMontoDian(d.deducciones)}) superan los devengados ` +
        `(${formatearMontoDian(d.devengados)}): el total pagado no puede ser negativo.`,
    );
  }
  if (d.total !== d.devengados - d.deducciones) {
    throw new Error(
      `El total de la nómina (${formatearMontoDian(d.total)}) no es devengados − deducciones ` +
        `(${formatearMontoDian(d.devengados)} − ${formatearMontoDian(d.deducciones)}).`,
    );
  }
  return (
    d.numero +
    d.fecha +
    d.hora +
    formatearMontoDian(d.devengados) +
    formatearMontoDian(d.deducciones) +
    formatearMontoDian(d.total) +
    d.nitEmpleador +
    d.docEmpleado +
    d.tipoXml +
    d.softwarePin +
    d.tipoAmbiente
  );
}

export function calcularCune(d: DatosCune): string {
  return createHash('sha384').update(cadenaCune(d), 'utf8').digest('hex');
}

/** CUNE de la nota de ajuste «Eliminar»: totales en 0.00, DocEmp «0» y TipoXML 103 (§8.1.1.4). */
export function calcularCuneEliminar(
  d: Omit<DatosCune, 'devengados' | 'deducciones' | 'total' | 'docEmpleado' | 'tipoXml'>,
): string {
  return calcularCune({ ...d, devengados: 0, deducciones: 0, total: 0, docEmpleado: '0', tipoXml: '103' });
}
