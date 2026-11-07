import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { calcularCude, calcularCufe } from '../cufe';
import { aCentavos } from '../redondeo';
import { firmarXml, verificarFirma } from '../../infrastructure/firma/firma-xades';
import { p12DePrueba } from '../p12-de-prueba.test';
import { validarXsdDian } from './__fixtures__/validar-xsd.test';
import { armarFacturaUbl, codigoSeguridadSoftware } from './factura-ubl';
import { prepararFacturaUbl, type DocumentoParaUbl } from './factura-de-documento';
import { armarPosUbl } from './pos-ubl';
import { prepararPosUbl, type DocumentoPosParaUbl } from './pos-de-documento';
import { DocumentoUblInvalidoError } from './xml-ubl';
import { CLAVE, documento, EMISOR_FISCAL, linea, PIN, SOFTWARE_ID } from './__fixtures__/factura-de-prueba.test';
import { documentoPos } from './__fixtures__/pos-de-prueba.test';

/**
 * Contingencia (Fase 9): los cuatro tipos firmados y contra el XSD oficial,
 * con el código único recalculado como lo hace la DIAN.
 *
 * - FEV 04 (DIAN caída): mismo número y mismo CUFE (clave técnica); tipo 04.
 * - FEV 03 (talonario): CUDE con el PIN (§11.1.4.2 nota 2) y
 *   `AdditionalDocumentReference` al papel.
 * - POS 08 y 07: `CustomizationID` 20 (anexo DE §16.4.1) y referencia.
 */
const CERT = { p12: p12DePrueba(), password: 'clave-de-prueba' };
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';

const parsear = (xml: string) => (new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document).documentElement;
function hijo(el: Element | undefined, ns: string, nombre: string): Element | undefined {
  if (!el) return undefined;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === nombre) return n as Element;
  }
  return undefined;
}
const texto = (el: Element | undefined, nombre: string) => hijo(el, NS_CBC, nombre)?.textContent ?? '';
const centavosDe = (s: string) => aCentavos(Number(s));

/** Valores del código único leídos del XML, como la DIAN. */
function valoresDelXml(xml: string) {
  const raiz = parsear(xml);
  const impuestos = { '01': 0, '04': 0, '03': 0 };
  for (let n = raiz.firstChild; n; n = n.nextSibling) {
    const el = n as Element;
    if (n.nodeType !== 1 || el.localName !== 'TaxTotal' || el.namespaceURI !== NS_CAC) continue;
    const sub = hijo(el, NS_CAC, 'TaxSubtotal');
    const codigo = texto(hijo(hijo(sub, NS_CAC, 'TaxCategory'), NS_CAC, 'TaxScheme'), 'ID');
    if (codigo in impuestos) impuestos[codigo as keyof typeof impuestos] = centavosDe(texto(el, 'TaxAmount'));
  }
  const total = hijo(raiz, NS_CAC, 'LegalMonetaryTotal');
  const nitDe = (rol: string) =>
    texto(hijo(hijo(hijo(raiz, NS_CAC, rol), NS_CAC, 'Party'), NS_CAC, 'PartyTaxScheme'), 'CompanyID');
  return {
    raiz,
    datos: {
      numero: texto(raiz, 'ID'),
      fecha: texto(raiz, 'IssueDate'),
      hora: texto(raiz, 'IssueTime'),
      valorBruto: centavosDe(texto(total, 'LineExtensionAmount')),
      impuestos,
      valorTotal: centavosDe(texto(total, 'PayableAmount')),
      nitEmisor: nitDe('AccountingSupplierParty'),
      numAdquiriente: nitDe('AccountingCustomerParty'),
      tipoAmbiente: texto(raiz, 'ProfileExecutionID') as '1' | '2',
    },
  };
}

function armarFactura(doc: DocumentoParaUbl): string {
  const f = prepararFacturaUbl(doc, EMISOR_FISCAL);
  return armarFacturaUbl({ ...f, codigoSeguridadSoftware: codigoSeguridadSoftware(SOFTWARE_ID, PIN, doc.fullNumber) });
}
function armarPos(doc: DocumentoPosParaUbl): string {
  const p = prepararPosUbl(doc, EMISOR_FISCAL);
  return armarPosUbl({ ...p, codigoSeguridadSoftware: codigoSeguridadSoftware(SOFTWARE_ID, PIN, doc.fullNumber) });
}

const IVA_19 = linea({ name: 'Camisa', precio: 119_000, impuesto: 19_000, rate: 19 });
const factura = (o: Partial<DocumentoParaUbl> = {}): DocumentoParaUbl => ({
  ...documento({ lines: [IVA_19], total: 119_000 }, { ambiente: '1' }),
  ...o,
});
const pos = (o: Partial<DocumentoPosParaUbl> = {}): DocumentoPosParaUbl => ({
  ...documentoPos({ lines: [IVA_19], total: 119_000 }, { ambiente: '1' }),
  ...o,
});

/** FEV 03: el CUDE se calcula con el PIN sobre los mismos valores (lo hace la emisión). */
function factura03(): DocumentoParaUbl {
  const base = factura({ prefix: 'CONT', fullNumber: 'CONT7' });
  const { datos } = valoresDelXml(armarFactura(base));
  return {
    ...base,
    cufe: calcularCude({ ...datos, softwarePin: PIN }),
    contingencia: { tipo: '03', referencia: { id: 'CONT7', fecha: '2026-11-04' } },
  };
}

describe('Contingencia · los cuatro tipos firmados contra el XSD', () => {
  const casos: Array<[string, () => string, 'clave' | 'pin', string, string]> = [
    ['FEV 04 (DIAN caída)', () => armarFactura(factura({ contingencia: { tipo: '04' } })), 'clave', '04', '10'],
    ['FEV 03 (talonario)', () => armarFactura(factura03()), 'pin', '03', '10'],
    [
      'POS 08 (DIAN caída)',
      () => armarPos(pos({ contingencia: { tipo: '08', referencia: { id: 'EPOS1', fecha: '2026-11-05' } } })),
      'pin',
      '08',
      '20',
    ],
    [
      'POS 07 (venta sin conexión)',
      () => armarPos(pos({ contingencia: { tipo: '07', referencia: { id: 'V-000123', fecha: '2026-11-04' } } })),
      'pin',
      '07',
      '20',
    ],
  ];
  it.each(casos)(
    '%s: firma, cumple el XSD, tipo y CustomizationID correctos y código único recalculado',
    async (nombre, xmlDe, llave, tipo, customization) => {
      const firmado = firmarXml(xmlDe(), CERT);
      expect(verificarFirma(firmado)).toEqual({ valida: true });
      const r = await validarXsdDian(firmado, `contingencia-${tipo}.xml`);
      expect(r.errores).toEqual([]);
      const { raiz, datos } = valoresDelXml(firmado);
      expect(texto(raiz, 'InvoiceTypeCode')).toBe(tipo);
      expect(texto(raiz, 'CustomizationID')).toBe(customization);
      const recalculado =
        llave === 'clave' ? calcularCufe({ ...datos, claveTecnica: CLAVE }) : calcularCude({ ...datos, softwarePin: PIN });
      expect(texto(raiz, 'UUID')).toBe(recalculado);
      expect(nombre).toBeTruthy();
    },
    60_000,
  );
});

describe('Contingencia · encabezado y referencia', () => {
  it('FEV 04: el MISMO CUFE de la factura normal y sin AdditionalDocumentReference', () => {
    const normal = factura();
    const xml = armarFactura({ ...normal, contingencia: { tipo: '04' } });
    const raiz = parsear(xml);
    expect(texto(raiz, 'UUID')).toBe(normal.cufe);
    expect(hijo(raiz, NS_CBC, 'UUID')?.getAttribute('schemeName')).toBe('CUFE-SHA384');
    expect(hijo(raiz, NS_CAC, 'AdditionalDocumentReference')).toBeUndefined();
  });

  it('FEV 03: UUID CUDE-SHA384 y referencia al papel con DocumentTypeCode 01', () => {
    const raiz = parsear(armarFactura(factura03()));
    expect(hijo(raiz, NS_CBC, 'UUID')?.getAttribute('schemeName')).toBe('CUDE-SHA384');
    const ref = hijo(raiz, NS_CAC, 'AdditionalDocumentReference');
    expect(texto(ref, 'ID')).toBe('CONT7');
    expect(texto(ref, 'IssueDate')).toBe('2026-11-04');
    expect(texto(ref, 'DocumentTypeCode')).toBe('01');
  });

  it('POS 08: mismo CUDE y referencia con DocumentTypeCode 20', () => {
    const normal = pos();
    const raiz = parsear(armarPos({ ...normal, contingencia: { tipo: '08', referencia: { id: normal.fullNumber, fecha: normal.issueDate } } }));
    expect(texto(raiz, 'UUID')).toBe(normal.cufe);
    expect(texto(hijo(raiz, NS_CAC, 'AdditionalDocumentReference'), 'DocumentTypeCode')).toBe('20');
  });

  it('un tipo que no es del documento, uno desconocido o sin referencia (03/07/08) se rechaza antes de firmar', () => {
    expect(() => armarFactura(factura({ contingencia: { tipo: '08', referencia: { id: 'X', fecha: '2026-11-01' } } }))).toThrow(
      DocumentoUblInvalidoError,
    );
    expect(() => armarPos(pos({ contingencia: { tipo: '04' } }))).toThrow(DocumentoUblInvalidoError);
    expect(() => armarFactura(factura({ contingencia: { tipo: '05' } }))).toThrow(/desconocido/);
    expect(() => armarPos(pos({ contingencia: { tipo: '07' } }))).toThrow(/número y la fecha/);
  });

  it('sin contingencia el documento sale exactamente igual que antes (tipo 01 / 20)', () => {
    expect(texto(parsear(armarFactura(factura())), 'InvoiceTypeCode')).toBe('01');
    expect(texto(parsear(armarPos(pos())), 'InvoiceTypeCode')).toBe('20');
    expect(texto(parsear(armarPos(pos())), 'CustomizationID')).toBe('10');
  });
});
