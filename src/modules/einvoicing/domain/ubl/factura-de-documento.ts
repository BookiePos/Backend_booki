import { dvNitValido } from '../../../customers/domain/datos-fiscales';
import { validarAdquirienteParaFactura } from '../adquiriente';
import { normalizarNit } from '../consecutivo-unico';
import type { CargoDocumento, LineaDocumento, TotalesDocumento, TributoLinea } from '../documento-venta';
import { CONSUMIDOR_FINAL_NIT } from '../einvoicing.constants';
import type { TipoAmbiente } from '../emisor-fiscal';
import { descuadresFactura, type FacturaUbl, type ParteUbl, type TributoParte } from './factura-ubl';
import { assertTextoXml, DocumentoUblInvalidoError, municipioDaneValido } from './xml-ubl';

/**
 * Del documento electrónico guardado (Fase 2) a la entrada del builder UBL.
 * Aquí se decide todo lo que puede impedir armar la factura —emisor o
 * adquiriente incompletos, resolución sin datos, documento que no cuadra— y se
 * dice qué corregir. Corre ANTES de leer el PIN y de firmar: un rechazo aquí no
 * consume nada.
 */

/** Lo que se lee del documento (estructuralmente, el `ElectronicDocument` guardado). */
export interface DocumentoParaUbl {
  type: string;
  prefix?: string;
  fullNumber: string;
  issueDate: string;
  issueTime: string;
  tipoAmbiente?: string;
  cufe?: string;
  emisor?: {
    name?: string;
    nit?: string;
    nitNorm?: string;
    nitDv?: string;
    tipoPersona?: string;
    responsabilidadFiscal?: string;
    address?: string;
    ciudad?: string;
    departamento?: string;
    phone?: string;
    email?: string;
  };
  adquiriente?: {
    docType?: string;
    docNumber?: string;
    name?: string;
    phone?: string;
    email?: string;
    nitDv?: string;
    tipoPersona?: string;
    responsabilidades?: string[];
    regimen?: string;
    municipioDane?: string;
    address?: string;
  };
  lines: Array<{
    code?: string;
    description: string;
    qty: number;
    unitCode?: string;
    unitPrice: number;
    discountAmount?: number;
    base: number;
    ivaRate?: number;
    ivaAmount?: number;
    taxScheme?: string;
    taxRate?: number;
    taxAmount?: number;
    perUnitTax?: { codigo: string; unidades: number; valorUnitario: number; valor: number };
    total: number;
  }>;
  charges?: CargoDocumento[];
  taxableBase: number;
  ivaTotal: number;
  taxExclusiveAmount?: number;
  incTotal?: number;
  icaTotal?: number;
  bagTaxTotal?: number;
  taxInclusiveAmount?: number;
  chargeTotal?: number;
  payableAmount?: number;
  formaPago?: string;
  medioPago?: string;
  resolution?: {
    numero?: string;
    prefijo?: string;
    rangoDesde?: number;
    rangoHasta?: number;
    vigenciaDesde?: Date;
    vigenciaHasta?: Date;
  };
}

/** Lo que se lee del emisor fiscal (`fiscal_emitters`), sin secretos. */
export interface EmisorParaUbl {
  municipioDane?: string;
  facturaSoftwareId?: string;
  responsableIva?: boolean;
  responsableInc?: boolean;
  granContribuyente?: boolean;
  regimenRenta?: string;
}

/** La factura lista para el builder, salvo el código de seguridad (que necesita el PIN). */
export type FacturaSinCodigo = Omit<FacturaUbl, 'codigoSeguridadSoftware'>;

const fecha = (d: Date | undefined): string | undefined =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : undefined;

export function lineas(doc: DocumentoParaUbl): LineaDocumento[] {
  if (!Array.isArray(doc.lines) || doc.lines.length === 0) {
    throw new DocumentoUblInvalidoError('El documento no tiene líneas');
  }
  return doc.lines.map((l, i) => {
    if (l.taxScheme !== undefined && l.taxScheme !== '01' && l.taxScheme !== '04') {
      throw new DocumentoUblInvalidoError(`Línea ${i + 1}: tributo desconocido «${l.taxScheme}»`);
    }
    if (l.perUnitTax && l.perUnitTax.codigo !== '22') {
      throw new DocumentoUblInvalidoError(`Línea ${i + 1}: tributo por unidad desconocido`);
    }
    return {
      code: l.code,
      description: l.description,
      qty: l.qty,
      unitCode: l.unitCode ?? '94',
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount ?? 0,
      base: l.base,
      taxScheme: l.taxScheme as TributoLinea | undefined,
      taxRate: l.taxScheme ? (l.taxRate ?? 0) : 0,
      taxAmount: l.taxScheme ? (l.taxAmount ?? 0) : 0,
      ivaRate: l.ivaRate ?? 0,
      ivaAmount: l.ivaAmount ?? 0,
      perUnitTax: l.perUnitTax ? { ...l.perUnitTax, codigo: '22' } : undefined,
      total: l.total,
    };
  });
}

export function totales(doc: DocumentoParaUbl): TotalesDocumento {
  // Un documento anterior a la Fase 2 no separa IVA de INC ni trae el PayableAmount.
  if (doc.payableAmount === undefined || doc.taxExclusiveAmount === undefined || doc.taxInclusiveAmount === undefined) {
    throw new DocumentoUblInvalidoError(
      'El documento es anterior a la Fase 2 (sin totales por tributo): no se puede armar su XML. Emite una nota crédito y vuelve a facturar.',
    );
  }
  return {
    taxableBase: doc.taxableBase,
    taxExclusiveAmount: doc.taxExclusiveAmount,
    ivaTotal: doc.ivaTotal,
    incTotal: doc.incTotal ?? 0,
    icaTotal: doc.icaTotal ?? 0,
    bagTaxTotal: doc.bagTaxTotal ?? 0,
    taxInclusiveAmount: doc.taxInclusiveAmount,
    chargeTotal: doc.chargeTotal ?? 0,
    payableAmount: doc.payableAmount,
  };
}

/**
 * Responsabilidades del emisor para el TaxLevelCode (tabla 13.2.6.1 del
 * anexo: O-13, O-15, O-23, O-47 o R-99-PN). La sede solo guarda una
 * «responsabilidad» simplificada; se completa con los indicadores del emisor.
 */
function responsabilidadesEmisor(doc: DocumentoParaUbl, e: EmisorParaUbl): string[] {
  const r = new Set<string>();
  const resp = doc.emisor?.responsabilidadFiscal;
  if (resp === 'gran_contribuyente' || e.granContribuyente) r.add('O-13');
  if (resp === 'regimen_simple' || e.regimenRenta === 'simple') r.add('O-47');
  return r.size ? [...r] : ['R-99-PN'];
}

export function emisorUbl(doc: DocumentoParaUbl, e: EmisorParaUbl, lineasDoc: LineaDocumento[]): ParteUbl {
  const d = doc.emisor ?? {};
  const nit = d.nitNorm ?? normalizarNit(d.nit) ?? '';
  const faltantes: string[] = [];
  if (!d.name?.trim()) faltantes.push('razón social');
  if (!/^\d{5,15}$/.test(nit)) faltantes.push('NIT');
  if (!d.nitDv?.trim()) faltantes.push('DV del NIT');
  else if (/^\d{5,15}$/.test(nit) && !dvNitValido(nit, d.nitDv)) faltantes.push('DV del NIT (no cuadra con el NIT)');
  if (d.tipoPersona !== 'juridica' && d.tipoPersona !== 'natural') faltantes.push('tipo de persona');
  if (!d.address?.trim()) faltantes.push('dirección');
  if (!d.ciudad?.trim()) faltantes.push('ciudad');
  if (!municipioDaneValido(e.municipioDane)) faltantes.push('municipio (código DANE de 5 dígitos)');
  if (!e.facturaSoftwareId?.trim()) faltantes.push('SoftwareID de factura');
  if (faltantes.length > 0) {
    throw new DocumentoUblInvalidoError(
      `Falta configurar los datos fiscales del emisor para armar la factura: ${faltantes.join(', ')}.`,
    );
  }
  // Quien cobra IVA o INC en sus líneas es responsable de ese impuesto aunque la ficha no lo diga.
  const iva =
    e.responsableIva === true ||
    d.responsabilidadFiscal === 'responsable_iva' ||
    d.responsabilidadFiscal === 'gran_contribuyente' ||
    lineasDoc.some((l) => l.taxScheme === '01');
  const inc = e.responsableInc === true || lineasDoc.some((l) => l.taxScheme === '04');
  const tributo: TributoParte = iva && inc ? 'ZA' : iva ? '01' : inc ? '04' : 'ZZ';
  return {
    tipoPersona: d.tipoPersona === 'juridica' ? '1' : '2',
    tipoDocumento: '31',
    numero: nit,
    dv: d.nitDv!.trim(),
    nombre: d.name!.trim(),
    responsabilidades: responsabilidadesEmisor(doc, e),
    listaResponsabilidades: iva ? '48' : '49',
    tributo,
    direccion: { municipioDane: e.municipioDane!, ciudad: d.ciudad!.trim(), linea: d.address!.trim() },
    email: d.email?.trim() || undefined,
    telefono: d.phone?.trim() || undefined,
  };
}

export const CONSUMIDOR_FINAL_UBL: ParteUbl = {
  tipoPersona: '2',
  tipoDocumento: '13',
  numero: CONSUMIDOR_FINAL_NIT,
  nombre: 'Consumidor final',
  responsabilidades: ['R-99-PN'],
  listaResponsabilidades: '49',
  tributo: 'ZZ',
};

function adquirienteUbl(doc: DocumentoParaUbl): ParteUbl {
  const a = doc.adquiriente;
  if (!a?.docNumber?.trim() || a.docNumber.trim() === CONSUMIDOR_FINAL_NIT) {
    return { ...CONSUMIDOR_FINAL_UBL, responsabilidades: [...CONSUMIDOR_FINAL_UBL.responsabilidades] };
  }
  // La misma validación que la emisión hizo antes del folio, ahora sobre lo congelado.
  const v = validarAdquirienteParaFactura({
    name: a.name,
    idNumber: a.docNumber,
    docType: a.docType,
    nitDv: a.nitDv,
    tipoPersona: a.tipoPersona,
    responsabilidades: a.responsabilidades,
    regimen: a.regimen,
    municipioDane: a.municipioDane,
    address: a.address,
    email: a.email,
  });
  if (!municipioDaneValido(a.municipioDane) && !v.faltantes.some((f) => f.startsWith('municipio'))) {
    v.faltantes.push('municipio (código DANE de 5 dígitos)');
  }
  if (v.faltantes.length > 0) {
    throw new DocumentoUblInvalidoError(
      `No se puede armar la factura: en los datos del cliente falta ${v.faltantes.join(', ')}.`,
    );
  }
  const responsable = a.regimen === 'responsable_iva';
  return {
    tipoPersona: a.tipoPersona === '1' ? '1' : '2',
    tipoDocumento: a.docType!,
    numero: a.docNumber.trim(),
    dv: a.docType === '31' ? a.nitDv?.trim() : undefined,
    nombre: a.name!.trim(),
    responsabilidades: [...(a.responsabilidades ?? [])],
    listaResponsabilidades: responsable ? '48' : '49',
    tributo: responsable ? '01' : 'ZZ',
    direccion: { municipioDane: a.municipioDane!, linea: a.address!.trim() },
    email: a.email?.trim() || undefined,
    telefono: a.phone?.trim() || undefined,
  };
}

export function resolucion(doc: DocumentoParaUbl): FacturaUbl['resolucion'] {
  const r = doc.resolution;
  const desde = fecha(r?.vigenciaDesde);
  const hasta = fecha(r?.vigenciaHasta);
  const faltantes: string[] = [];
  if (!r?.numero?.trim()) faltantes.push('número');
  if (!desde || !hasta) faltantes.push('vigencia');
  if (!Number.isSafeInteger(r?.rangoDesde) || !Number.isSafeInteger(r?.rangoHasta)) faltantes.push('rango');
  if (faltantes.length > 0) {
    throw new DocumentoUblInvalidoError(`La resolución de numeración del documento está incompleta: ${faltantes.join(', ')}.`);
  }
  return {
    numero: r!.numero!.trim(),
    desde: desde!,
    hasta: hasta!,
    prefijo: r!.prefijo || undefined,
    rangoDesde: r!.rangoDesde!,
    rangoHasta: r!.rangoHasta!,
  };
}

/**
 * Valida el documento y arma la entrada del builder. Lanza
 * `DocumentoUblInvalidoError` con lo que hay que corregir.
 */
export function prepararFacturaUbl(doc: DocumentoParaUbl, emisor: EmisorParaUbl): FacturaSinCodigo {
  if (doc.type !== 'invoice') {
    throw new DocumentoUblInvalidoError(`Este builder arma facturas de venta, no «${doc.type}»`);
  }
  if (!doc.cufe) throw new DocumentoUblInvalidoError('El documento no tiene CUFE');
  if (doc.tipoAmbiente !== '1' && doc.tipoAmbiente !== '2') {
    throw new DocumentoUblInvalidoError('El documento no tiene el ambiente con el que se calculó su CUFE');
  }
  // Primero lo que dice si el documento es de la Fase 2; después sus líneas.
  const totalesDoc = totales(doc);
  const lineasDoc = lineas(doc);
  const f: FacturaSinCodigo = {
    numero: doc.fullNumber,
    prefijo: doc.prefix || undefined,
    cufe: doc.cufe,
    fecha: doc.issueDate,
    hora: doc.issueTime,
    tipoAmbiente: doc.tipoAmbiente as TipoAmbiente,
    resolucion: resolucion(doc),
    softwareId: emisor.facturaSoftwareId?.trim() ?? '',
    emisor: emisorUbl(doc, emisor, lineasDoc),
    adquiriente: adquirienteUbl(doc),
    formaPago: doc.formaPago === '2' ? '2' : '1',
    medioPago: doc.medioPago?.trim() || '10',
    lineas: lineasDoc,
    cargos: doc.charges ?? [],
    totales: totalesDoc,
  };
  // Antes del PIN y de la firma: un texto que XML no admite es un 400 que dice el campo.
  assertTextoXml(f, '');
  const fallas = descuadresFactura(f);
  if (fallas.length > 0) throw new DocumentoUblInvalidoError(`El documento no cuadra: ${fallas.join('; ')}`);
  return f;
}
