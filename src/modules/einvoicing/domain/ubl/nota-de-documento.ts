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
import { esquemaDeOrigen, faltantesNota, type NotaUbl } from './nota-ubl';
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
  /** Tipo del documento referido (el `type` del documento de `referenceId`): `pos` o `invoice`. */
  referenceType?: string;
  /** Algoritmo del código referido; debe coincidir con el tipo del documento referido. */
  referenceScheme?: string;
  /** Periodo de una nota sin referencia. */
  period?: { desde: string; hasta: string };
}

export type DocumentoNotaParaUbl = DocumentoParaUbl & CamposNotaDocumento;

/** La nota lista para el builder, salvo el código de seguridad (que necesita el PIN). */
export type NotaSinCodigo = NotaUbl extends infer T ? (T extends unknown ? Omit<T, 'codigoSeguridadSoftware'> : never) : never;

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
  // Un POS se corrige con su nota de ajuste (94/93), no con la 91: lo decide el TIPO del documento referido.
  // Fase 6B: con referencia, el tipo del documento referido es obligatorio. Sin él no se sabe si la nota es
  // la 91 de la factura o la 94 del POS, y adivinar «factura» mandaría a la DIAN una 91 sobre un CUDE de POS.
  if (tieneReferencia && !doc.referenceType) {
    throw new DocumentoUblInvalidoError('La nota no dice qué documento corrige (factura o POS): falta el tipo del documento referido');
  }
  if (tieneReferencia && doc.referenceType !== 'pos' && doc.referenceType !== 'invoice') {
    throw new DocumentoUblInvalidoError(`La nota no puede corregir un documento «${doc.referenceType}»`);
  }
  if (!tieneReferencia && doc.referenceType === 'pos') {
    throw new DocumentoUblInvalidoError('La nota de ajuste del POS siempre lleva la referencia al documento POS');
  }
  const origen = doc.referenceType === 'pos' ? 'pos' : 'factura';
  const esperado = esquemaDeOrigen(origen);
  if (tieneReferencia && doc.referenceScheme !== undefined && doc.referenceScheme !== esperado) {
    throw new DocumentoUblInvalidoError(
      `El código del documento referido debe ser ${esperado} (${origen === 'pos' ? 'POS' : 'factura'}), no «${doc.referenceScheme}»`,
    );
  }
  const n = {
    tipo: doc.type === 'credit_note' ? 'credito' : 'debito',
    origen,
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
          esquema: esperado,
        }
      : undefined,
    periodo: doc.period,
  } as NotaSinCodigo;
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
