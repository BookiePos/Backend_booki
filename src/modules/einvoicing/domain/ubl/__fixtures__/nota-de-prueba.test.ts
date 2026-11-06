import { documentoDeVenta, type VentaParaDocumento } from '../../documento-venta';
import { buildAdquiriente, type ClienteVenta } from '../../adquiriente';
import { cudeDeNota, type NotaUbl } from '../nota-ubl';
import type { DocumentoNotaParaUbl } from '../nota-de-documento';
import { lineas } from '../factura-de-documento';
import { codigoSeguridadSoftware } from '../factura-ubl';
import { documento, NIT, PIN, SOFTWARE_ID } from './factura-de-prueba.test';

/**
 * Notas de prueba para el builder (Fase 6A): salen de una venta con
 * `documentoDeVenta` (las líneas de la nota son las de una venta parcial) y su
 * CUDE se calcula con el PIN, como en la emisión. Nada es un dato real.
 */
export const FACTURA_REFERIDA = {
  numero: 'SETP990000001',
  cufe: 'a'.repeat(96),
  fecha: '2026-10-30',
};

export interface OpcionesNota {
  tipo: 'credit_note' | 'debit_note';
  cliente?: ClienteVenta;
  numero?: number;
  concepto: string;
  descripcion?: string;
  referencia?: boolean;
  /** Corrige un documento POS (nota de ajuste 94/93). */
  pos?: boolean;
  periodo?: { desde: string; hasta: string };
}

/** Documento de nota guardado, con su CUDE ya calculado. */
export function documentoNota(venta: VentaParaDocumento, o: OpcionesNota): DocumentoNotaParaUbl {
  const base = documento(venta, { cliente: o.cliente });
  const d = documentoDeVenta(venta);
  const adq = buildAdquiriente(o.cliente);
  const fullNumber = `NC${o.numero ?? 1}`;
  const cude = cudeDeNota(
    {
      numero: fullNumber,
      fecha: '2026-11-02',
      hora: '09:30:00-05:00',
      tipoAmbiente: '2',
      emisor: { numero: NIT } as NotaUbl['emisor'],
      adquiriente: { numero: adq.docNumber } as NotaUbl['adquiriente'],
      lineas: lineas(base),
      cargos: d.charges,
    },
    PIN,
  );
  const sinRef = o.referencia === false;
  return {
    ...base,
    type: o.tipo,
    prefix: 'NC',
    fullNumber,
    issueDate: '2026-11-02',
    issueTime: '09:30:00-05:00',
    cufe: cude,
    discrepancyCode: o.concepto,
    reason: o.descripcion ?? 'Corrección de la factura',
    referenceNumber: sinRef ? undefined : FACTURA_REFERIDA.numero,
    referenceCufe: sinRef ? undefined : FACTURA_REFERIDA.cufe,
    referenceIssueDate: sinRef ? undefined : FACTURA_REFERIDA.fecha,
    referenceScheme: o.pos ? 'CUDE-SHA384' : undefined,
    period: o.periodo,
  };
}

export function codigoSeguridadNota(fullNumber: string): string {
  return codigoSeguridadSoftware(SOFTWARE_ID, PIN, fullNumber);
}

