import { assertFechaHoraDian, calcularCude } from '../cufe';
import type { CargoDocumento, LineaDocumento, TotalesDocumento } from '../documento-venta';
import type { TipoAmbiente } from '../emisor-fiscal';
import {
  cargosXml,
  descuadresFactura,
  dianExtensions,
  legalMonetaryTotal,
  lineaXml,
  medioDePago,
  NS_STS,
  parte,
  taxTotalesCabecera,
  totalesUbl,
  validarParte,
  type EtiquetasLinea,
  type ParteUbl,
} from './factura-ubl';
import { DocumentoUblInvalidoError, esc } from './xml-ubl';

/**
 * Builder UBL 2.1 de la NOTA CRÉDITO (`CreditNote`) y la NOTA DÉBITO
 * (`DebitNote`) electrónicas (anexo técnico FEV 1.9, Res. DIAN 000165 de 2023).
 * Función pura, hermana de `armarFacturaUbl`: reutiliza sus piezas (partes,
 * pagos, tributos por línea, totales desde `totalesUbl`) y devuelve el XML SIN
 * firmar, con la segunda `ext:UBLExtension` vacía para la XAdES.
 *
 * - `DiscrepancyResponse` es obligatorio: concepto de corrección + descripción.
 * - `BillingReference` lleva número, CUFE/CUDE y fecha del documento corregido.
 *   Sin referencia (CustomizationID 22 / 32, solo FEV) el periodo (`InvoicePeriod`,
 *   máximo 30 días dentro de un mes) es obligatorio y la nota crédito no admite el
 *   concepto 2 (regla CBF03a).
 * - Nota de ajuste del documento equivalente POS (`origen: 'pos'`, art. 22 de la
 *   Res. 165/2023): crédito 94 / débito 93, CustomizationID 20, CUDE con
 *   `calcularCudePos` y SIEMPRE con referencia al POS (número, CUDE y fecha).
 *   El POS no se corrige con la nota 91 de la factura.
 * - Los números de las tablas de conceptos salen de fuentes secundarias
 *   (Factus, NumRot): a verificar contra el anexo 1.9.
 * - Los valores nunca son negativos: la nota se escribe en positivo y el tipo
 *   de documento dice el sentido. Los totales son la suma de las líneas.
 * - El CUDE se calcula con `cudeDeNota` (PIN del software, nunca la clave
 *   técnica de la resolución). Las notas no llevan `InvoiceControl`.
 */

export type TipoNota = 'credito' | 'debito';

/** Conceptos de corrección (tablas del anexo FEV 1.9, DiscrepancyResponse/ResponseCode). */
export const CONCEPTOS_NOTA_CREDITO: Record<string, string> = {
  '1': 'Devolución parcial de los bienes y/o no aceptación parcial del servicio',
  '2': 'Anulación de factura electrónica',
  '3': 'Rebaja o descuento parcial o total',
  '4': 'Ajuste de precio',
  '5': 'Descuento comercial por pronto pago',
  '6': 'Descuento comercial por volumen de ventas',
};
export const CONCEPTOS_NOTA_DEBITO: Record<string, string> = {
  '1': 'Intereses',
  '2': 'Gastos por cobrar',
  '3': 'Cambio del valor',
  '4': 'Otro',
};

/** Conceptos de la nota de ajuste crédito del POS (anexo DE v1.0 §16.6; 5 = Otros). A verificar contra el anexo. */
export const CONCEPTOS_AJUSTE_POS_CREDITO: Record<string, string> = {
  '1': 'Devolución parcial de los bienes y/o no aceptación parcial del servicio',
  '2': 'Anulación del documento equivalente electrónico',
  '3': 'Rebaja o descuento parcial o total',
  '4': 'Ajuste de precio',
  '5': 'Otros',
};

/** Regla CBF03a: la nota crédito sin referencia no admite la anulación. */
export const CONCEPTO_NO_ADMITIDO_SIN_REFERENCIA = '2';

interface PerfilNota {
  raiz: 'CreditNote' | 'DebitNote';
  ns: string;
  customizationConReferencia: string;
  customizationSinReferencia: string;
  profileId: string;
  conceptos: Record<string, string>;
  etiquetas: EtiquetasLinea;
  documento: string;
  /** `cbc:CreditNoteTypeCode`; la nota débito no lo tiene en el XSD. */
  tipoCodigo?: string;
}

const PERFIL: Record<TipoNota, PerfilNota> = {
  credito: {
    raiz: 'CreditNote',
    ns: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
    customizationConReferencia: '20',
    customizationSinReferencia: '22',
    profileId: 'DIAN 2.1: Nota Crédito de Factura Electrónica de Venta',
    conceptos: CONCEPTOS_NOTA_CREDITO,
    etiquetas: { linea: 'CreditNoteLine', cantidad: 'CreditedQuantity', gratuito: true },
    documento: 'La nota crédito',
    tipoCodigo: '91',
  },
  debito: {
    raiz: 'DebitNote',
    ns: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
    customizationConReferencia: '30',
    customizationSinReferencia: '32',
    profileId: 'DIAN 2.1: Nota Débito de Factura Electrónica de Venta',
    conceptos: CONCEPTOS_NOTA_DEBITO,
    etiquetas: { linea: 'DebitNoteLine', cantidad: 'DebitedQuantity', gratuito: false },
    documento: 'La nota débito',
  },
};

/** Notas de ajuste del POS: siempre con referencia, CustomizationID 20. */
const PERFIL_POS: Record<TipoNota, PerfilNota> = {
  credito: {
    ...PERFIL.credito,
    customizationConReferencia: '20',
    profileId: 'DIAN 2.1: Nota de ajuste crédito al documento equivalente',
    conceptos: CONCEPTOS_AJUSTE_POS_CREDITO,
    documento: 'La nota de ajuste crédito del POS',
    tipoCodigo: '94',
  },
  // El tipo 93 no tiene elemento en el XSD de DebitNote: se infiere de la raíz. ProfileID a confirmar en habilitación.
  debito: {
    ...PERFIL.debito,
    customizationConReferencia: '20',
    profileId: 'DIAN 2.1: Nota de ajuste débito al documento equivalente',
    documento: 'La nota de ajuste débito del POS',
  },
};

export function perfilDeNota(n: Pick<NotaUbl, 'tipo' | 'origen'>): PerfilNota | undefined {
  return (n.origen === 'pos' ? PERFIL_POS : PERFIL)[n.tipo];
}

/** Días entre dos fechas AAAA-MM-DD (inclusive en ambos extremos). */
function diasInclusive(desde: string, hasta: string): number {
  return (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000 + 1;
}

export interface ReferenciaNota {
  /** Número completo (prefijo + consecutivo) del documento corregido. */
  numero: string;
  /** CUFE (factura) o CUDE (documento POS) del documento corregido. */
  cufe: string;
  /** YYYY-MM-DD de emisión del documento corregido. */
  fecha: string;
  /** Algoritmo del código referido. Por defecto CUFE (factura). */
  esquema?: 'CUFE-SHA384' | 'CUDE-SHA384';
}

export interface NotaUbl {
  tipo: TipoNota;
  /** Qué documento corrige: la factura (por defecto) o el documento equivalente POS. */
  origen?: 'factura' | 'pos';
  /** Prefijo + número (cbc:ID). */
  numero: string;
  prefijo?: string;
  /** CUDE de la nota (`cudeDeNota`). */
  cude: string;
  /** YYYY-MM-DD y HH:MM:SS-05:00: los MISMOS del CUDE. */
  fecha: string;
  hora: string;
  tipoAmbiente: TipoAmbiente;
  softwareId: string;
  codigoSeguridadSoftware: string;
  emisor: ParteUbl;
  adquiriente: ParteUbl;
  /** 1 contado, 2 crédito. */
  formaPago: '1' | '2';
  medioPago: string;
  vencimiento?: string;
  lineas: LineaDocumento[];
  cargos: CargoDocumento[];
  totales: TotalesDocumento;
  concepto: { codigo: string; descripcion: string };
  referencia?: ReferenciaNota;
  /** Periodo (`InvoicePeriod`): obligatorio sin referencia. */
  periodo?: { desde: string; hasta: string };
}

const SHA384_HEX = /^[0-9a-f]{96}$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** CUDE de la nota con el PIN del software; los valores salen SOLO de las líneas y los cargos. */
export function cudeDeNota(
  n: Pick<NotaUbl, 'numero' | 'fecha' | 'hora' | 'tipoAmbiente' | 'emisor' | 'adquiriente' | 'lineas' | 'cargos'>,
  softwarePin: string,
): string {
  const t = totalesUbl(n.lineas, n.cargos);
  return calcularCude({
    numero: n.numero,
    fecha: n.fecha,
    hora: n.hora,
    valorBruto: t.lineExtension,
    impuestos: { '01': t.iva, '04': t.inc, '03': 0 },
    valorTotal: t.payable,
    nitEmisor: n.emisor.numero,
    numAdquiriente: n.adquiriente.numero,
    softwarePin,
    tipoAmbiente: n.tipoAmbiente,
  });
}

/** Lo que falta o sobra en la nota; vacío si se puede armar. */
export function faltantesNota(n: NotaUbl): string[] {
  const p = perfilDeNota(n);
  if (!p) return ['tipo de nota'];
  const fallas: string[] = [];
  const codigo = n.concepto?.codigo;
  if (!codigo || !Object.prototype.hasOwnProperty.call(p.conceptos, codigo)) {
    fallas.push(`concepto de corrección (${Object.keys(p.conceptos).join('-')})`);
  }
  if (!n.concepto?.descripcion?.trim()) fallas.push('descripción del concepto de corrección');
  const r = n.referencia;
  if (r) {
    if (!r.numero?.trim()) fallas.push('número del documento referido');
    if (!SHA384_HEX.test(r.cufe ?? '')) fallas.push('CUFE/CUDE del documento referido (SHA-384 en hexadecimal)');
    if (!FECHA.test(r.fecha ?? '')) fallas.push('fecha del documento referido');
  } else {
    if (n.origen === 'pos') fallas.push('referencia al documento POS (la nota de ajuste siempre la lleva)');
    else if (n.tipo === 'credito' && codigo === CONCEPTO_NO_ADMITIDO_SIN_REFERENCIA) {
      fallas.push(`referencia a la factura (la anulación, concepto ${CONCEPTO_NO_ADMITIDO_SIN_REFERENCIA}, no puede ir sin ella)`);
    }
    if (!n.periodo) fallas.push('periodo (obligatorio en una nota sin referencia)');
  }
  if (n.periodo) {
    if (!FECHA.test(n.periodo.desde ?? '') || !FECHA.test(n.periodo.hasta ?? '')) fallas.push('periodo (AAAA-MM-DD)');
    else if (n.periodo.desde > n.periodo.hasta) fallas.push('periodo (inicio posterior al fin)');
    else if (!r && (diasInclusive(n.periodo.desde, n.periodo.hasta) > 30 || n.periodo.desde.slice(0, 7) !== n.periodo.hasta.slice(0, 7))) {
      fallas.push('periodo (máximo 30 días y dentro de un mismo mes)');
    }
  }
  if (!n.numero?.trim()) fallas.push('número');
  if (!SHA384_HEX.test(n.cude ?? '')) fallas.push('CUDE (SHA-384 en hexadecimal)');
  if (n.tipoAmbiente !== '1' && n.tipoAmbiente !== '2') fallas.push('tipo de ambiente');
  if (!SHA384_HEX.test(n.codigoSeguridadSoftware ?? '')) fallas.push('código de seguridad del software');
  if (!n.softwareId?.trim()) fallas.push('SoftwareID');
  if (n.formaPago !== '1' && n.formaPago !== '2') fallas.push('forma de pago');
  if (!/^[0-9A-Z]{1,3}$/.test(n.medioPago ?? '')) fallas.push('medio de pago');
  if (n.vencimiento !== undefined && !FECHA.test(n.vencimiento)) fallas.push('vencimiento');
  if (!Array.isArray(n.lineas) || n.lineas.length === 0) fallas.push('líneas');
  return fallas;
}

function armarNota(n: NotaUbl): string {
  const p = perfilDeNota(n);
  if (!p) throw new DocumentoUblInvalidoError('La nota no se puede armar; revisa: tipo de nota');
  const fallas = faltantesNota(n);
  if (fallas.length > 0) {
    throw new DocumentoUblInvalidoError(`${p.documento} no se puede armar; revisa: ${fallas.join(', ')}`);
  }
  try {
    assertFechaHoraDian(n.fecha, n.hora);
  } catch (err) {
    throw new DocumentoUblInvalidoError((err as Error).message);
  }
  validarParte(n.emisor, 'Emisor');
  validarParte(n.adquiriente, 'Adquiriente');
  if (n.emisor.tipoDocumento !== '31' || !n.emisor.dv) {
    throw new DocumentoUblInvalidoError('Emisor: el facturador se identifica con NIT y DV');
  }
  // Valores nunca negativos (`centavos` lo rechaza) y totales = suma de líneas, con tolerancia 0.
  const descuadre = descuadresFactura(n);
  if (descuadre.length > 0) throw new DocumentoUblInvalidoError(`El documento no cuadra: ${descuadre.join('; ')}`);
  const t = totalesUbl(n.lineas, n.cargos);
  if (t.lineExtension === 0) throw new DocumentoUblInvalidoError(`${p.documento} no puede ser por valor cero`);

  const periodo = n.periodo
    ? `
  <cac:InvoicePeriod>
    <cbc:StartDate>${esc(n.periodo.desde)}</cbc:StartDate>
    <cbc:EndDate>${esc(n.periodo.hasta)}</cbc:EndDate>
  </cac:InvoicePeriod>`
    : '';
  const referenciaId = n.referencia ? `\n    <cbc:ReferenceID>${esc(n.referencia.numero)}</cbc:ReferenceID>` : '';
  const billing = n.referencia
    ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(n.referencia.numero)}</cbc:ID>
      <cbc:UUID schemeName="${n.referencia.esquema ?? (n.origen === 'pos' ? 'CUDE-SHA384' : 'CUFE-SHA384')}">${n.referencia.cufe}</cbc:UUID>
      <cbc:IssueDate>${n.referencia.fecha}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`
    : '';
  const pago = medioDePago({
    formaPago: n.formaPago,
    medio: n.medioPago,
    vence: n.formaPago === '2' ? (n.vencimiento ?? n.fecha) : undefined,
  });
  const cargos = cargosXml(n.cargos, t.lineExtension);
  const impuestos = taxTotalesCabecera(n.lineas);
  const monetario = legalMonetaryTotal(t, n.cargos.length > 0);
  // El XSD de DebitNote ordena AllowanceCharge antes de PaymentMeans y llama al total RequestedMonetaryTotal.
  const bloqueFinanciero =
    n.tipo === 'credito'
      ? `${pago}${cargos}${impuestos}
  ${monetario}`
      : `${cargos ? `${cargos.trimStart()}\n  ` : ''}${pago}${impuestos}
  ${monetario.replace(/LegalMonetaryTotal/g, 'RequestedMonetaryTotal')}`;
  const tipoCodigo = p.tipoCodigo ? `\n  <cbc:CreditNoteTypeCode>${p.tipoCodigo}</cbc:CreditNoteTypeCode>` : '';
  const dianExt = dianExtensions({
    emisor: n.emisor,
    softwareId: n.softwareId,
    codigoSeguridadSoftware: n.codigoSeguridadSoftware,
    tipoAmbiente: n.tipoAmbiente,
    cufe: n.cude,
  });
  const customizacion = n.referencia ? p.customizationConReferencia : p.customizationSinReferencia;
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<${p.raiz} xmlns="${p.ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="${NS_STS}">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        ${dianExt}
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent></ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>${customizacion}</cbc:CustomizationID>
  <cbc:ProfileID>${p.profileId}</cbc:ProfileID>
  <cbc:ProfileExecutionID>${n.tipoAmbiente}</cbc:ProfileExecutionID>
  <cbc:ID>${esc(n.numero)}</cbc:ID>
  <cbc:UUID schemeID="${n.tipoAmbiente}" schemeName="CUDE-SHA384">${n.cude}</cbc:UUID>
  <cbc:IssueDate>${n.fecha}</cbc:IssueDate>
  <cbc:IssueTime>${n.hora}</cbc:IssueTime>${tipoCodigo}
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${n.lineas.length}</cbc:LineCountNumeric>${periodo}
  <cac:DiscrepancyResponse>${referenciaId}
    <cbc:ResponseCode>${n.concepto.codigo}</cbc:ResponseCode>
    <cbc:Description>${esc(n.concepto.descripcion.trim())}</cbc:Description>
  </cac:DiscrepancyResponse>${billing}
  ${parte('AccountingSupplierParty', n.emisor, n.prefijo)}
  ${parte('AccountingCustomerParty', n.adquiriente)}
  ${bloqueFinanciero}${n.lineas.map((l, i) => lineaXml(l, i, p.etiquetas)).join('')}
</${p.raiz}>
`;
}

/** XML UBL 2.1 de la nota crédito, SIN firmar. Lanza `DocumentoUblInvalidoError` si algo no cuadra. */
export function armarNotaCreditoUbl(n: Omit<NotaUbl, 'tipo'>): string {
  return armarNota({ ...n, tipo: 'credito' });
}

/** Nota de ajuste crédito (94) del documento equivalente POS, SIN firmar. */
export function armarNotaAjusteCreditoPosUbl(n: Omit<NotaUbl, 'tipo' | 'origen'>): string {
  return armarNota({ ...n, tipo: 'credito', origen: 'pos' });
}

/** Nota de ajuste débito (93) del documento equivalente POS, SIN firmar. */
export function armarNotaAjusteDebitoPosUbl(n: Omit<NotaUbl, 'tipo' | 'origen'>): string {
  return armarNota({ ...n, tipo: 'debito', origen: 'pos' });
}

/** XML UBL 2.1 de la nota débito, SIN firmar. Lanza `DocumentoUblInvalidoError` si algo no cuadra. */
export function armarNotaDebitoUbl(n: Omit<NotaUbl, 'tipo'>): string {
  return armarNota({ ...n, tipo: 'debito' });
}
