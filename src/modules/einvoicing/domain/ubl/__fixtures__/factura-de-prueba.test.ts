import { documentoDeVenta, type VentaParaDocumento } from '../../documento-venta';
import { buildAdquiriente, type ClienteVenta } from '../../adquiriente';
import { calcularCufe } from '../../cufe';
import type { DocumentoParaUbl, EmisorParaUbl } from '../factura-de-documento';

/**
 * Documentos de prueba para el builder UBL (Fase 5A): salen de una venta con
 * `documentoDeVenta` (Fase 2) y su CUFE se calcula con `calcularCufe`, como en
 * la emisión. Nada de esto es un dato real.
 */
export const CLAVE = 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c';
export const SOFTWARE_ID = '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0';
export const PIN = 'pin-secreto-12345';
export const NIT = '900123456';
export const DV = '8';

export const EMISOR_FISCAL: EmisorParaUbl = {
  municipioDane: '05001',
  facturaSoftwareId: SOFTWARE_ID,
  responsableIva: true,
};

export const CLIENTE_NIT: ClienteVenta = {
  name: 'Ópticas & Cía S.A.S.',
  idNumber: '900108281',
  docType: '31',
  nitDv: '3',
  tipoPersona: '1',
  responsabilidades: ['O-13', 'O-15'],
  regimen: 'responsable_iva',
  municipioDane: '11001',
  address: 'Cra 8 # 20-14',
  emailFacturacion: 'facturas@opticas.co',
};

/** Línea de venta gravada con el impuesto incluido en el precio. */
export function linea(o: {
  name: string;
  precio: number;
  impuesto: number;
  kind?: 'iva' | 'inc' | 'ninguno';
  rate: number;
  qty?: number;
  treatment?: 'gravado' | 'exento' | 'excluido';
  bolsa?: number;
}) {
  const qty = o.qty ?? 1;
  return {
    sku: o.name.slice(0, 3).toUpperCase(),
    name: o.name,
    qty,
    unitPrice: o.precio / qty,
    lineTotal: o.precio,
    taxKind: o.kind ?? 'iva',
    taxRate: o.rate,
    taxTreatment: o.treatment,
    taxBase: o.precio - o.impuesto,
    taxAmount: o.impuesto,
    bagTax: o.bolsa,
    bagTaxUnit: o.bolsa ? o.bolsa / qty : undefined,
  };
}

export function documento(
  venta: VentaParaDocumento,
  o: { cliente?: ClienteVenta; formaPago?: string; numero?: number; ambiente?: '1' | '2' } = {},
): DocumentoParaUbl {
  const d = documentoDeVenta(venta);
  const adquiriente = buildAdquiriente(o.cliente);
  const numero = o.numero ?? 990000001;
  const fullNumber = `SETP${numero}`;
  const tipoAmbiente = o.ambiente ?? '2';
  const issueDate = '2026-10-30';
  const issueTime = '10:15:00-05:00';
  const cufe = calcularCufe({
    numero: fullNumber,
    fecha: issueDate,
    hora: issueTime,
    ...d.codigoUnico,
    nitEmisor: NIT,
    numAdquiriente: adquiriente.docNumber,
    claveTecnica: CLAVE,
    tipoAmbiente,
  });
  return {
    type: 'invoice',
    prefix: 'SETP',
    fullNumber,
    issueDate,
    issueTime,
    tipoAmbiente,
    cufe,
    emisor: {
      name: 'Crunchy Pruebas S.A.S.',
      nit: `${NIT}-${DV}`,
      nitNorm: NIT,
      nitDv: DV,
      tipoPersona: 'juridica',
      responsabilidadFiscal: 'responsable_iva',
      address: 'Calle 10 # 43-12',
      ciudad: 'Medellín',
      departamento: 'Antioquia',
      phone: '6041234567',
      email: 'facturacion@crunchy.co',
    },
    adquiriente,
    lines: d.lines,
    charges: d.charges,
    ...d.totales,
    formaPago: o.formaPago ?? '1',
    medioPago: '10',
    resolution: {
      numero: '18760000001',
      prefijo: 'SETP',
      rangoDesde: 990000000,
      rangoHasta: 995000000,
      vigenciaDesde: new Date('2019-01-19'),
      vigenciaHasta: new Date('2030-01-19'),
    },
  };
}

