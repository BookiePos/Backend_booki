import { createHash } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { calcularCufe, dianVerificationUrl } from '../cufe';
import { aCentavos } from '../redondeo';
import { firmarXml, verificarFirma } from '../../infrastructure/firma/firma-xades';
import { p12DePrueba } from '../p12-de-prueba.test';
import { validarXsdDian } from './__fixtures__/validar-xsd.test';
import { armarFacturaUbl, codigoSeguridadSoftware, NS_STS } from './factura-ubl';
import {
  prepararFacturaUbl,
  type DocumentoParaUbl,
  type EmisorParaUbl,
} from './factura-de-documento';
import { DocumentoUblInvalidoError } from './xml-ubl';
import {
  CLAVE,
  CLIENTE_NIT,
  documento,
  DV,
  EMISOR_FISCAL,
  linea,
  NIT,
  SOFTWARE_ID,
  PIN,
} from './__fixtures__/factura-de-prueba.test';

/**
 * Builder UBL 2.1 de la factura de venta (anexo FEV 1.9, Fase 5A). Cada
 * variante se arma desde una venta real (`documentoDeVenta`, Fase 2), se firma
 * con el .p12 de prueba y se valida contra los XSD oficiales de la DIAN. El
 * CUFE del XML se recalcula con los valores que la DIAN lee del propio XML.
 */
const PASSWORD = 'clave-de-prueba';
const CERT = { p12: p12DePrueba(), password: PASSWORD };

const sha384 = (s: string) => createHash('sha384').update(s, 'utf8').digest('hex');

function armar(doc: DocumentoParaUbl, emisor: EmisorParaUbl = EMISOR_FISCAL): string {
  const f = prepararFacturaUbl(doc, emisor);
  return armarFacturaUbl({ ...f, codigoSeguridadSoftware: codigoSeguridadSoftware(SOFTWARE_ID, PIN, doc.fullNumber) });
}

// ── Lectura del XML (lo que lee la DIAN) ─────────────────────────────────────
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';

function hijo(el: Element, ns: string, nombre: string): Element | undefined {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === nombre) {
      return n as Element;
    }
  }
  return undefined;
}
const texto = (el: Element | undefined, nombre: string) => (el ? hijo(el, NS_CBC, nombre)?.textContent ?? '' : '');
const centavosDe = (s: string) => aCentavos(Number(s));

/** Recalcula el CUFE con los valores del XML (anexo FEV 1.9 §11.1.2), como la DIAN. */
function cufeDelXml(xml: string, claveTecnica: string): { uuid: string; recalculado: string } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const raiz = doc.documentElement;
  const impuestos = { '01': 0, '04': 0, '03': 0 };
  for (let n = raiz.firstChild; n; n = n.nextSibling) {
    const el = n as Element;
    if (n.nodeType !== 1 || el.localName !== 'TaxTotal' || el.namespaceURI !== NS_CAC) continue;
    const sub = hijo(el, NS_CAC, 'TaxSubtotal')!;
    const codigo = texto(hijo(hijo(sub, NS_CAC, 'TaxCategory')!, NS_CAC, 'TaxScheme'), 'ID');
    if (codigo in impuestos) impuestos[codigo as keyof typeof impuestos] = centavosDe(texto(el, 'TaxAmount'));
  }
  const total = hijo(raiz, NS_CAC, 'LegalMonetaryTotal');
  const nitDe = (rol: string) =>
    texto(hijo(hijo(hijo(raiz, NS_CAC, rol)!, NS_CAC, 'Party')!, NS_CAC, 'PartyTaxScheme'), 'CompanyID');
  const recalculado = calcularCufe({
    numero: texto(raiz, 'ID'),
    fecha: texto(raiz, 'IssueDate'),
    hora: texto(raiz, 'IssueTime'),
    valorBruto: centavosDe(texto(total, 'LineExtensionAmount')),
    impuestos,
    valorTotal: centavosDe(texto(total, 'PayableAmount')),
    nitEmisor: nitDe('AccountingSupplierParty'),
    numAdquiriente: nitDe('AccountingCustomerParty'),
    claveTecnica,
    tipoAmbiente: texto(raiz, 'ProfileExecutionID') as '1' | '2',
  });
  return { uuid: texto(raiz, 'UUID'), recalculado };
}

// ── Variantes ────────────────────────────────────────────────────────────────
const IVA_19 = linea({ name: 'Camisa', precio: 119_000, impuesto: 19_000, rate: 19 });
const VARIANTES: Record<string, DocumentoParaUbl> = {
  'consumidor final con IVA 19 %': documento({ lines: [IVA_19], total: 119_000 }),
  'adquiriente con NIT': documento({ lines: [IVA_19], total: 119_000 }, { cliente: CLIENTE_NIT }),
  'adquiriente persona natural con cédula': documento(
    { lines: [IVA_19], total: 119_000 },
    {
      cliente: {
        ...CLIENTE_NIT,
        name: 'Ana Pérez',
        idNumber: '1020304050',
        docType: '13',
        nitDv: undefined,
        tipoPersona: '2',
        responsabilidades: ['R-99-PN'],
        regimen: 'no_responsable_iva',
      },
    },
  ),
  'restaurante con INC 8 %': documento({
    lines: [linea({ name: 'Bandeja paisa', precio: 32_400, impuesto: 2_400, kind: 'inc', rate: 8, qty: 2 })],
    total: 32_400,
  }),
  'IVA con varias tarifas y producto exento': documento({
    lines: [
      IVA_19,
      linea({ name: 'Arroz', precio: 10_500, impuesto: 500, rate: 5 }),
      linea({ name: 'Leche', precio: 4_000, impuesto: 0, rate: 0, treatment: 'exento' }),
      linea({ name: 'Pan', precio: 3_000, impuesto: 0, rate: 0, treatment: 'excluido' }),
    ],
    total: 136_500,
  }),
  'solo exento': documento({
    lines: [linea({ name: 'Leche', precio: 4_000, impuesto: 0, rate: 0, treatment: 'exento' })],
    total: 4_000,
  }),
  'domicilio, propina y bolsa': documento({
    lines: [
      linea({ name: 'Hamburguesa', precio: 29_750, impuesto: 4_750, rate: 19 }),
      linea({ name: 'Bolsa', precio: 119, impuesto: 19, rate: 19, qty: 2, bolsa: 146 }),
    ],
    total: 29_750 + 119 + 146,
    tip: 3_000,
    deliveryFee: 5_950,
    deliveryTaxKind: 'iva',
    deliveryTaxRate: 19,
    deliveryTaxBase: 5_000,
    deliveryTax: 950,
  }),
  'venta a crédito en producción': documento(
    { lines: [IVA_19], total: 119_000 },
    { cliente: CLIENTE_NIT, formaPago: '2', ambiente: '1' },
  ),  // Venta anterior al desglose por línea que cobró bolsas: la bolsa solo trae el tributo 22.
  'venta sin desglose con línea de solo bolsa': documento({
    lines: [
      { name: 'Pan', qty: 1, unitPrice: 3_000, lineTotal: 3_000 },
      { name: 'Bolsa', qty: 2, unitPrice: 50, lineTotal: 100, bagTaxUnit: 73, bagTax: 146 },
    ],
    total: 3_246,
  }),
};

describe('factura UBL 2.1 · variantes contra el XSD oficial, firmadas', () => {
  it.each(Object.entries(VARIANTES))(
    '%s: firma, verifica, cumple el XSD y el CUFE del XML es el recalculado',
    async (nombre, doc) => {
      const xml = armar(doc);
      const firmado = firmarXml(xml, CERT);
      expect(verificarFirma(firmado)).toEqual({ valida: true });
      const r = await validarXsdDian(firmado, `${nombre.replace(/\W+/g, '-')}.xml`);
      expect(r.errores).toEqual([]);
      const { uuid, recalculado } = cufeDelXml(firmado, CLAVE);
      expect(uuid).toBe(doc.cufe);
      expect(recalculado).toBe(doc.cufe);
    },
    60_000,
  );

  it('sin firma NO cumple el XSD: la ranura de la firma no puede ir vacía', async () => {
    const r = await validarXsdDian(armar(VARIANTES['consumidor final con IVA 19 %']!), 'sin-firma.xml');
    expect(r.valido).toBe(false);
    expect(r.errores.join(' ')).toMatch(/ExtensionContent/);
  }, 60_000);
});

describe('factura UBL 2.1 · contenido', () => {
  const doc = VARIANTES['domicilio, propina y bolsa']!;
  const xml = armar(doc);

  it('DianExtensions en la primera UBLExtension y la segunda vacía para la firma', () => {
    const exts = xml.match(/<ext:UBLExtension>[\s\S]*?<\/ext:UBLExtension>/g) ?? [];
    expect(exts).toHaveLength(2);
    expect(exts[0]).toContain('<sts:DianExtensions>');
    expect(exts[1]).toMatch(/<ext:ExtensionContent>\s*<\/ext:ExtensionContent>/);
    expect(xml).toContain(`xmlns:sts="${NS_STS}"`);
  });

  it('InvoiceControl con la resolución, el rango y la vigencia', () => {
    expect(xml).toContain('<sts:InvoiceAuthorization>18760000001</sts:InvoiceAuthorization>');
    expect(xml).toContain('<cbc:StartDate>2019-01-19</cbc:StartDate>');
    expect(xml).toContain('<cbc:EndDate>2030-01-19</cbc:EndDate>');
    expect(xml).toMatch(/<sts:Prefix>SETP<\/sts:Prefix>\s*<sts:From>990000000<\/sts:From>\s*<sts:To>995000000<\/sts:To>/);
  });

  it('SoftwareProvider (software propio: NIT y DV del emisor), código de seguridad y QR', () => {
    expect(xml).toMatch(new RegExp(`<sts:ProviderID [^>]*schemeID="${DV}" schemeName="31">${NIT}</sts:ProviderID>`));
    expect(xml).toContain(`>${SOFTWARE_ID}</sts:SoftwareID>`);
    expect(xml).toContain(`>${sha384(SOFTWARE_ID + PIN + doc.fullNumber)}</sts:SoftwareSecurityCode>`);
    expect(xml).toMatch(/schemeID="4" schemeName="31">800197268<\/sts:AuthorizationProviderID>/);
    expect(xml).toContain(`<sts:QRCode>${dianVerificationUrl(doc.cufe!, '2')}</sts:QRCode>`);
  });

  it('el PIN no aparece en el XML', () => {
    expect(xml).not.toContain(PIN);
  });

  it('ProfileExecutionID y el schemeID del UUID son el ambiente del documento', () => {
    expect(xml).toContain('<cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>');
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${doc.cufe}</cbc:UUID>`);
    const prod = armar(VARIANTES['venta a crédito en producción']!);
    expect(prod).toContain('<cbc:ProfileExecutionID>1</cbc:ProfileExecutionID>');
    expect(prod).toMatch(/<cbc:UUID schemeID="1" schemeName="CUFE-SHA384">/);
  });

  it('propina como cargo no gravado y totales desde las líneas', () => {
    expect(xml).toMatch(
      /<cac:AllowanceCharge>\s*<cbc:ID>1<\/cbc:ID>\s*<cbc:ChargeIndicator>true<\/cbc:ChargeIndicator>\s*<cbc:AllowanceChargeReason>Propina voluntaria<\/cbc:AllowanceChargeReason>/,
    );
    expect(xml).toContain('<cbc:Amount currencyID="COP">3000.00</cbc:Amount>');
    // Bases 25.000 + 100 + 5.000 (domicilio); IVA 4.750 + 19 + 950; bolsa 146; propina 3.000.
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="COP">30100.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="COP">30100.00</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="COP">35965.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:ChargeTotalAmount currencyID="COP">3000.00</cbc:ChargeTotalAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="COP">38965.00</cbc:PayableAmount>');
    expect(doc.payableAmount).toBe(38_965);
  });

  it('el domicilio va como línea propia con su IVA', () => {
    expect(xml).toMatch(/<cbc:Description>Servicio de domicilio<\/cbc:Description>/);
  });

  it('la bolsa lleva su IVA y aparte el tributo 22 por unidad', () => {
    expect(xml).toMatch(
      /<cbc:TaxAmount currencyID="COP">146.00<\/cbc:TaxAmount>\s*<cac:TaxSubtotal>\s*<cbc:TaxableAmount currencyID="COP">0.00<\/cbc:TaxableAmount>\s*<cbc:TaxAmount currencyID="COP">146.00<\/cbc:TaxAmount>\s*<cbc:BaseUnitMeasure unitCode="94">2.00<\/cbc:BaseUnitMeasure>\s*<cbc:PerUnitAmount currencyID="COP">73.00<\/cbc:PerUnitAmount>/,
    );
    expect(xml).toMatch(/<cbc:ID>22<\/cbc:ID>\s*<cbc:Name>INC Bolsas<\/cbc:Name>/);
  });

  it('TaxTotal de cabecera por tributo con un subtotal por tarifa; el excluido no lleva tributo', () => {
    const varias = armar(VARIANTES['IVA con varias tarifas y producto exento']!);
    const cabecera = varias.slice(0, varias.indexOf('<cac:LegalMonetaryTotal>'));
    const totales = cabecera.match(/<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/g) ?? [];
    expect(totales).toHaveLength(1);
    expect(totales[0]).toContain('<cbc:TaxAmount currencyID="COP">19500.00</cbc:TaxAmount>');
    expect(totales[0]!.match(/<cbc:Percent>/g)).toHaveLength(3);
    expect(totales[0]).toContain('<cbc:Percent>0.00</cbc:Percent>');
    // FAU04: el exento suma a TaxExclusiveAmount, el excluido no.
    expect(varias).toContain('<cbc:TaxExclusiveAmount currencyID="COP">114000.00</cbc:TaxExclusiveAmount>');
    expect(varias).toContain('<cbc:LineExtensionAmount currencyID="COP">117000.00</cbc:LineExtensionAmount>');
    const lineas = varias.match(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g) ?? [];
    expect(lineas).toHaveLength(4);
    expect(lineas[3]).not.toContain('<cac:TaxTotal>');
    expect(varias).toContain('<cbc:LineCountNumeric>4</cbc:LineCountNumeric>');
  });

  it('INC con su tributo 04 y la cantidad en la línea', () => {
    const inc = armar(VARIANTES['restaurante con INC 8 %']!);
    expect(inc).toMatch(/<cbc:Percent>8.00<\/cbc:Percent>\s*<cac:TaxScheme>\s*<cbc:ID>04<\/cbc:ID>\s*<cbc:Name>INC<\/cbc:Name>/);
    expect(inc).toContain('<cbc:InvoicedQuantity unitCode="94">2.00</cbc:InvoicedQuantity>');
  });

  it('consumidor final: 222222222222, persona natural, R-99-PN', () => {
    const cf = armar(VARIANTES['consumidor final con IVA 19 %']!);
    const cliente = cf.slice(cf.indexOf('<cac:AccountingCustomerParty>'), cf.indexOf('</cac:AccountingCustomerParty>'));
    expect(cliente).toContain('<cbc:AdditionalAccountID>2</cbc:AdditionalAccountID>');
    expect(cliente).toMatch(/schemeName="13">222222222222<\/cbc:CompanyID>/);
    expect(cliente).toContain('R-99-PN</cbc:TaxLevelCode>');
  });

  it('adquiriente con NIT: DV en schemeID, responsabilidades y municipio DANE; texto escapado', () => {
    const conNit = armar(VARIANTES['adquiriente con NIT']!);
    const cliente = conNit.slice(conNit.indexOf('<cac:AccountingCustomerParty>'));
    expect(cliente).toContain('<cbc:AdditionalAccountID>1</cbc:AdditionalAccountID>');
    expect(cliente).toMatch(/schemeID="3" schemeName="31">900108281<\/cbc:CompanyID>/);
    expect(cliente).toContain('<cbc:TaxLevelCode listName="48">O-13;O-15</cbc:TaxLevelCode>');
    expect(cliente).toContain('<cbc:ID>11001</cbc:ID>');
    expect(cliente).toContain('<cbc:Name>Ópticas &amp; Cía S.A.S.</cbc:Name>');
  });

  it('emisor: NIT con DV, persona jurídica, municipio DANE y prefijo', () => {
    const emisor = xml.slice(xml.indexOf('<cac:AccountingSupplierParty>'), xml.indexOf('</cac:AccountingSupplierParty>'));
    expect(emisor).toContain('<cbc:AdditionalAccountID>1</cbc:AdditionalAccountID>');
    expect(emisor).toMatch(new RegExp(`schemeID="${DV}" schemeName="31">${NIT}</cbc:CompanyID>`));
    expect(emisor).toContain('<cbc:ID>05001</cbc:ID>');
    expect(emisor).toContain('<cbc:CountrySubentity>Antioquia</cbc:CountrySubentity>');
    expect(emisor).toContain('<cac:CorporateRegistrationScheme>\n          <cbc:ID>SETP</cbc:ID>');
  });

  it('forma de pago: contado 1; crédito 2 con fecha de vencimiento', () => {
    expect(xml).toMatch(/<cac:PaymentMeans>\s*<cbc:ID>1<\/cbc:ID>\s*<cbc:PaymentMeansCode>10<\/cbc:PaymentMeansCode>\s*<\/cac:PaymentMeans>/);
    const credito = armar(VARIANTES['venta a crédito en producción']!);
    expect(credito).toMatch(/<cbc:ID>2<\/cbc:ID>\s*<cbc:PaymentMeansCode>10<\/cbc:PaymentMeansCode>\s*<cbc:PaymentDueDate>2026-10-30<\/cbc:PaymentDueDate>/);
  });
});

describe('factura UBL 2.1 · línea con solo el tributo 22 (FAU04)', () => {
  const xml = armar(VARIANTES['venta sin desglose con línea de solo bolsa']!);
  const lineas = xml.match(/<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/g) ?? [];

  it('su único TaxSubtotal es el 22 con TaxableAmount 0.00, y TaxExclusiveAmount es la suma de esos 0', () => {
    expect(lineas[0]).not.toContain('<cac:TaxTotal>');
    expect(lineas[1]!.match(/<cac:TaxSubtotal>/g)).toHaveLength(1);
    expect(lineas[1]).toMatch(/<cbc:TaxableAmount currencyID="COP">0.00<\/cbc:TaxableAmount>[\s\S]*<cbc:ID>22<\/cbc:ID>/);
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="COP">0.00</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="COP">3100.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="COP">3246.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="COP">3246.00</cbc:PayableAmount>');
  });

  it('un documento guardado que sumó la base de esa línea al TaxExclusiveAmount no cuadra', () => {
    const doc = VARIANTES['venta sin desglose con línea de solo bolsa']!;
    expect(() => armar({ ...doc, taxExclusiveAmount: 100 })).toThrow(/TaxExclusiveAmount/);
  });
});

describe('factura UBL 2.1 · se rechaza antes de firmar', () => {
  const base = VARIANTES['adquiriente con NIT']!;

  it('un carácter de control que XML 1.0 no admite, diciendo dónde', () => {
    const lines = base.lines.map((l, i) => (i === 0 ? { ...l, description: 'Camisa\u0007azul' } : l));
    expect(() => armar({ ...base, lines })).toThrow(DocumentoUblInvalidoError);
    expect(() => armar({ ...base, lines })).toThrow(/carácter de control/);
    const adquiriente = { ...base.adquiriente!, name: 'Ópticas\u001b' };
    expect(() => armar({ ...base, adquiriente })).toThrow(/carácter de control/);
    // Tab y salto de línea sí son XML válido.
    const conTab = base.lines.map((l, i) => (i === 0 ? { ...l, description: 'Camisa\tazul' } : l));
    expect(armar({ ...base, lines: conTab })).toContain('Camisa\tazul');
  });

  it('un total que no es la suma de las líneas', () => {
    expect(() => armar({ ...base, payableAmount: (base.payableAmount ?? 0) + 1 })).toThrow(DocumentoUblInvalidoError);
    expect(() => armar({ ...base, ivaTotal: base.ivaTotal - 1 })).toThrow(/no cuadra/);
    expect(() => armar({ ...base, taxExclusiveAmount: 0 })).toThrow(/no cuadra/);
  });

  it('una línea cuyo total no es base + impuestos', () => {
    const lines = base.lines.map((l) => ({ ...l, total: l.total + 1 }));
    expect(() => armar({ ...base, lines })).toThrow(/no cuadra/);
  });

  it('montos con fracción (no se redondean en silencio)', () => {
    const lines = base.lines.map((l) => ({ ...l, base: l.base + 0.5, total: l.total + 0.5 }));
    expect(() => armar({ ...base, lines })).toThrow(DocumentoUblInvalidoError);
  });

  it('un adquiriente incompleto, diciendo qué falta', () => {
    const adquiriente = { ...base.adquiriente!, municipioDane: undefined, nitDv: '9' };
    expect(() => armar({ ...base, adquiriente })).toThrow(/municipio/);
    expect(() => armar({ ...base, adquiriente })).toThrow(/DV/);
  });

  it('un emisor sin municipio DANE, sin DV o sin SoftwareID', () => {
    expect(() => armar(base, { ...EMISOR_FISCAL, municipioDane: undefined })).toThrow(/municipio/);
    expect(() => armar({ ...base, emisor: { ...base.emisor!, nitDv: '1' } })).toThrow(/DV/);
    expect(() => armar(base, { ...EMISOR_FISCAL, facturaSoftwareId: undefined })).toThrow(/SoftwareID/);
  });

  it('un documento anterior a la Fase 2 (sin totales por tributo)', () => {
    expect(() => armar({ ...base, payableAmount: undefined })).toThrow(/Fase 2/);
  });

  it('un tipo que no es factura, o sin CUFE', () => {
    expect(() => armar({ ...base, type: 'credit_note' })).toThrow(DocumentoUblInvalidoError);
    expect(() => armar({ ...base, cufe: undefined })).toThrow(/CUFE/);
  });

  it('sin resolución completa', () => {
    expect(() => armar({ ...base, resolution: { ...base.resolution!, vigenciaHasta: undefined } })).toThrow(/resolución/);
  });
});

describe('código de seguridad del software', () => {
  it('es SHA-384(SoftwareID + PIN + número)', () => {
    expect(codigoSeguridadSoftware(SOFTWARE_ID, PIN, 'SETP990000001')).toBe(
      sha384(`${SOFTWARE_ID}${PIN}SETP990000001`),
    );
  });

  it('sin PIN falla sin citar nada secreto', () => {
    expect(() => codigoSeguridadSoftware(SOFTWARE_ID, ' ', 'SETP1')).toThrow(/PIN/);
    try {
      codigoSeguridadSoftware('', PIN, 'SETP1');
    } catch (err) {
      expect((err as Error).message).not.toContain(PIN);
    }
  });
});
