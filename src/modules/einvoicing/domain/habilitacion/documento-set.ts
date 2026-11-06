import { calcularCudePos, calcularCufe } from '../cufe';
import { documentoDeVenta, type LineaVenta, type VentaParaDocumento } from '../documento-venta';
import { codigoSeguridadSoftware, armarFacturaUbl } from '../ubl/factura-ubl';
import { prepararFacturaUbl, type DocumentoParaUbl, type EmisorParaUbl } from '../ubl/factura-de-documento';
import { prepararPosUbl, type DocumentoPosParaUbl } from '../ubl/pos-de-documento';
import { armarPosUbl } from '../ubl/pos-ubl';
import { RESOLUCION_SETP, type TipoDocSet } from './set-habilitacion-factura';

/**
 * Documento de PRUEBA del set de habilitación: se arma con los MISMOS
 * preparadores y builders UBL de la emisión real (`prepararFacturaUbl` /
 * `prepararPosUbl`), así que valida lo mismo, pero a partir de datos sintéticos:
 * resolución pública SETP, adquiriente de prueba y líneas inventadas. No lee ni
 * escribe ninguna venta, folio, cartera ni inventario. Adaptado de
 * `armarDocumentoSet` de AlíaCorp (`habilitacion.ts`).
 */

/** Lo que se necesita del emisor (copia de `fiscal_emitters`, sin secretos). */
export interface EmisorParaSet {
  razonSocial?: string;
  nit?: string;
  nitNorm: string;
  nitDv?: string;
  tipoPersona?: string;
  responsabilidadFiscal?: string;
  direccion?: string;
  ciudad?: string;
  departamento?: string;
  telefono?: string;
  emailFacturacion?: string;
  municipioDane?: string;
  facturaSoftwareId?: string;
  responsableIva?: boolean;
  responsableInc?: boolean;
  granContribuyente?: boolean;
  regimenRenta?: string;
}

/**
 * Adquiriente de los documentos de prueba: la propia DIAN (NIT real y DV correcto), como en AlíaCorp
 * (`ADQUIRIENTE_SET_PRUEBAS`). No es un cliente del negocio.
 */
export const ADQUIRIENTE_SET = {
  docType: '31',
  docNumber: '800197268',
  nitDv: '4',
  name: 'DIRECCION DE IMPUESTOS Y ADUANAS NACIONALES',
  tipoPersona: '1',
  responsabilidades: ['O-13'],
  regimen: 'responsable_iva',
  municipioDane: '11001',
  address: 'CR 8 # 6C-38',
  email: 'pruebas.habilitacion@example.com',
} as const;

/** Caja y fabricante del POS de prueba (sintéticos; el fabricante real lo pone `FE_FABRICANTE_*` en la emisión). */
const CAJA_SET = {
  placa: 'CAJA-PRUEBA',
  ubicacion: 'Habilitacion DIAN',
  tipo: 'Caja de prueba',
  cajero: 'Cajero de prueba',
  codigoVenta: 'SET-PRUEBA',
};
const FABRICANTE_SET = { nombreApellido: 'BookiPos', nombreSoftware: 'BookiPos' };

/** Tres líneas variadas: IVA 19 %, INC 8 % y exenta (precio con impuesto incluido, en pesos). */
const L_IVA = (): LineaVenta => ({
  sku: 'SET-IVA',
  name: 'Producto de prueba IVA 19',
  qty: 1,
  unitPrice: 119_000,
  lineTotal: 119_000,
  taxKind: 'iva',
  taxRate: 19,
  taxBase: 100_000,
  taxAmount: 19_000,
});
const L_INC = (): LineaVenta => ({
  sku: 'SET-INC',
  name: 'Consumo de prueba INC 8',
  qty: 2,
  unitPrice: 54_000,
  lineTotal: 108_000,
  taxKind: 'inc',
  taxRate: 8,
  taxBase: 100_000,
  taxAmount: 8_000,
});
const L_EXENTA = (): LineaVenta => ({
  sku: 'SET-EXE',
  name: 'Producto de prueba exento',
  qty: 1,
  unitPrice: 50_000,
  lineTotal: 50_000,
  taxKind: 'iva',
  taxRate: 0,
  taxTreatment: 'exento',
  taxBase: 50_000,
  taxAmount: 0,
});

/** Combinaciones que rotan por posición en el set, para que la DIAN vea todos los tributos. */
const COMBINACIONES: ReadonlyArray<ReadonlyArray<() => LineaVenta>> = [
  [L_IVA],
  [L_INC],
  [L_EXENTA],
  [L_IVA, L_INC],
  [L_IVA, L_EXENTA],
  [L_INC, L_EXENTA],
  [L_IVA, L_INC, L_EXENTA],
  [L_IVA, L_IVA],
];

export function ventaSintetica(posicion: number): VentaParaDocumento {
  const lines = COMBINACIONES[posicion % COMBINACIONES.length]!.map((f) => f());
  return { lines, total: lines.reduce((a, l) => a + (l.lineTotal ?? 0), 0) };
}

export interface EntradaDocumentoSet {
  tipo: TipoDocSet;
  numero: number;
  /** Posición del documento dentro del set (elige las líneas). */
  posicion: number;
  fecha: string;
  hora: string;
  emisor: EmisorParaSet;
  softwareId: string;
  softwarePin: string;
}

export interface DocumentoSetArmado {
  numeroCompleto: string;
  /** CUFE (factura) o CUDE (POS). */
  codigo: string;
  xml: string;
}

/** Arma el XML SIN firmar de una factura o un POS de prueba. Lanza `DocumentoUblInvalidoError` si el emisor no alcanza. */
export function armarDocumentoSet(e: EntradaDocumentoSet): DocumentoSetArmado {
  if (e.tipo !== 'fv' && e.tipo !== 'pos') {
    throw new Error(`El documento «${e.tipo}» del set todavía no tiene armador.`);
  }
  const R = RESOLUCION_SETP;
  const venta = ventaSintetica(e.posicion);
  const d = documentoDeVenta(venta);
  const numeroCompleto = `${R.prefijo}${e.numero}`;
  const base = {
    nitEmisor: e.emisor.nitNorm,
    numAdquiriente: ADQUIRIENTE_SET.docNumber,
    numero: numeroCompleto,
    fecha: e.fecha,
    hora: e.hora,
    ...d.codigoUnico,
    tipoAmbiente: '2' as const,
  };
  // Factura: CUFE con la clave técnica de la resolución. POS: CUDE con el PIN (anexo DE §14.1.3).
  const codigo =
    e.tipo === 'fv'
      ? calcularCufe({ ...base, claveTecnica: R.claveTecnica })
      : calcularCudePos({ ...base, softwarePin: e.softwarePin });

  const doc: DocumentoParaUbl = {
    type: e.tipo === 'fv' ? 'invoice' : 'pos',
    prefix: R.prefijo,
    fullNumber: numeroCompleto,
    issueDate: e.fecha,
    issueTime: e.hora,
    tipoAmbiente: '2',
    cufe: codigo,
    emisor: {
      name: e.emisor.razonSocial,
      nit: e.emisor.nit ?? e.emisor.nitNorm,
      nitNorm: e.emisor.nitNorm,
      nitDv: e.emisor.nitDv,
      tipoPersona: e.emisor.tipoPersona,
      responsabilidadFiscal: e.emisor.responsabilidadFiscal,
      address: e.emisor.direccion,
      ciudad: e.emisor.ciudad,
      departamento: e.emisor.departamento,
      phone: e.emisor.telefono,
      email: e.emisor.emailFacturacion,
    },
    adquiriente: {
      docType: ADQUIRIENTE_SET.docType,
      docNumber: ADQUIRIENTE_SET.docNumber,
      nitDv: ADQUIRIENTE_SET.nitDv,
      name: ADQUIRIENTE_SET.name,
      tipoPersona: ADQUIRIENTE_SET.tipoPersona,
      responsabilidades: [...ADQUIRIENTE_SET.responsabilidades],
      regimen: ADQUIRIENTE_SET.regimen,
      municipioDane: ADQUIRIENTE_SET.municipioDane,
      address: ADQUIRIENTE_SET.address,
      email: ADQUIRIENTE_SET.email,
    },
    lines: d.lines,
    charges: d.charges,
    ...d.totales,
    formaPago: '1',
    medioPago: '10',
    resolution: {
      numero: R.numero,
      prefijo: R.prefijo,
      rangoDesde: R.desde,
      rangoHasta: R.hasta,
      vigenciaDesde: new Date(R.vigenciaDesde),
      vigenciaHasta: new Date(R.vigenciaHasta),
    },
  };
  const datosEmisor: EmisorParaUbl = {
    municipioDane: e.emisor.municipioDane,
    facturaSoftwareId: e.softwareId,
    responsableIva: e.emisor.responsableIva,
    responsableInc: e.emisor.responsableInc,
    granContribuyente: e.emisor.granContribuyente,
    regimenRenta: e.emisor.regimenRenta,
  };

  if (e.tipo === 'pos') {
    const pos = prepararPosUbl(
      {
        ...doc,
        cajaVenta: { ...CAJA_SET },
        fabricante: { ...FABRICANTE_SET },
        pagos: [{ metodo: 'cash', monto: d.totales.payableAmount, formaPago: '1' }],
      } as DocumentoPosParaUbl,
      datosEmisor,
    );
    return {
      numeroCompleto,
      codigo,
      xml: armarPosUbl({ ...pos, codigoSeguridadSoftware: codigoSeguridadSoftware(pos.softwareId, e.softwarePin, numeroCompleto) }),
    };
  }
  const f = prepararFacturaUbl(doc, datosEmisor);
  return {
    numeroCompleto,
    codigo,
    xml: armarFacturaUbl({ ...f, codigoSeguridadSoftware: codigoSeguridadSoftware(f.softwareId, e.softwarePin, numeroCompleto) }),
  };
}
