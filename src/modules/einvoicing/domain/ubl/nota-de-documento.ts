import type { TipoAmbiente } from '../emisor-fiscal';
import { descuadresFactura } from './factura-ubl';
import {
  adquirienteUbl,
  emisorUbl,
  lineas,
  totales,
  type DocumentoParaUbl,
  type EmisorParaUbl,
} from './factura-de-documento';
import { faltantesNota, type NotaUbl } from './nota-ubl';
import { assertTextoXml, DocumentoUblInvalidoError } from './xml-ubl';

/**
 * Del documento `credit_note` / `debit_note` guardado a la entrada de
 * `armarNotaCreditoUbl` / `armarNotaDebitoUbl`. Como `prepararFacturaUbl`: decide
 * lo que puede impedir armar el XML y dice qué corregir, ANTES de leer el PIN.
 */

/** Lo que la nota guarda además de lo de la factura. */
export interface CamposNotaDocumento {
  /** Descripción del concepto (`DiscrepancyResponse/Description`). */
  reason?: string;
  /** Código del concepto de corrección (`DiscrepancyResponse/ResponseCode`). */
  discrepancyCode?: string;
  referenceNumber?: string;
  referenceCufe?: string;
  /** YYYY-MM-DD de emisión del documento referido. */
  referenceIssueDate?: string;
  /** Algoritmo del código referido; por defecto CUFE. */
  referenceScheme?: 'CUFE-SHA384' | 'CUDE-SHA384';
  /** Periodo de una nota sin referencia. */
  period?: { desde: string; hasta: string };
}

export type DocumentoNotaParaUbl = DocumentoParaUbl & CamposNotaDocumento;

/** La nota lista para el builder, salvo el código de seguridad (que necesita el PIN). */
export type NotaSinCodigo = Omit<NotaUbl, 'codigoSeguridadSoftware'>;

export function prepararNotaUbl(doc: DocumentoNotaParaUbl, emisor: EmisorParaUbl): NotaSinCodigo {
  if (doc.type !== 'credit_note' && doc.type !== 'debit_note') {
    throw new DocumentoUblInvalidoError(`Este builder arma notas crédito y débito, no «${doc.type}»`);
  }
  if (!doc.cufe) throw new DocumentoUblInvalidoError('La nota no tiene CUDE');
  if (doc.tipoAmbiente !== '1' && doc.tipoAmbiente !== '2') {
    throw new DocumentoUblInvalidoError('La nota no tiene el ambiente con el que se calculó su CUDE');
  }
  const totalesDoc = totales(doc);
  const lineasDoc = lineas(doc);
  const tieneReferencia = Boolean(doc.referenceNumber?.trim());
  const n: NotaSinCodigo = {
    tipo: doc.type === 'credit_note' ? 'credito' : 'debito',
    // Un código referido que es CUDE es el de un POS: se corrige con su nota de ajuste (94/93), no con la 91.
    origen: doc.referenceScheme === 'CUDE-SHA384' ? 'pos' : 'factura',
    numero: doc.fullNumber,
    prefijo: doc.prefix || undefined,
    cude: doc.cufe,
    fecha: doc.issueDate,
    hora: doc.issueTime,
    tipoAmbiente: doc.tipoAmbiente as TipoAmbiente,
    softwareId: emisor.facturaSoftwareId?.trim() ?? '',
    emisor: emisorUbl(doc, emisor, lineasDoc),
    adquiriente: adquirienteUbl(doc),
    formaPago: doc.formaPago === '2' ? '2' : '1',
    medioPago: doc.medioPago?.trim() || '10',
    lineas: lineasDoc,
    cargos: doc.charges ?? [],
    totales: totalesDoc,
    concepto: { codigo: doc.discrepancyCode?.trim() ?? '', descripcion: doc.reason ?? '' },
    referencia: tieneReferencia
      ? {
          numero: doc.referenceNumber!.trim(),
          cufe: doc.referenceCufe?.trim() ?? '',
          fecha: doc.referenceIssueDate ?? '',
          esquema: doc.referenceScheme,
        }
      : undefined,
    periodo: doc.period,
  };
  assertTextoXml(n, '');
  // Concepto, referencia y periodo se rechazan aquí, antes de leer el PIN (el código de seguridad aún no existe).
  const faltantes = faltantesNota({ ...n, codigoSeguridadSoftware: '0'.repeat(96) });
  if (faltantes.length > 0) {
    throw new DocumentoUblInvalidoError(`La nota no se puede armar; revisa: ${faltantes.join(', ')}`);
  }
  const fallas = descuadresFactura(n);
  if (fallas.length > 0) throw new DocumentoUblInvalidoError(`El documento no cuadra: ${fallas.join('; ')}`);
  return n;
}
