import { createHash } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { calcularCudePos, dianVerificationUrl } from '../cufe';
import { aCentavos } from '../redondeo';
import { firmarXml, verificarFirma } from '../../infrastructure/firma/firma-xades';
import { p12DePrueba } from '../p12-de-prueba.test';
import { validarXsdDian } from './__fixtures__/validar-xsd.test';
import { codigoSeguridadSoftware } from './factura-ubl';
import { CLIENTE_NIT, EMISOR_FISCAL, linea, PIN, SOFTWARE_ID } from './__fixtures__/factura-de-prueba.test';
import { CAJA, documentoPos, DV, FABRICANTE, NIT } from './__fixtures__/pos-de-prueba.test';
import { armarPosUbl, EXTENSIONES_POS, PERFIL_POS } from './pos-ubl';
import { prepararPosUbl, type DocumentoPosParaUbl } from './pos-de-documento';
import type { EmisorParaUbl } from './factura-de-documento';
import { DocumentoUblInvalidoError } from './xml-ubl';

/**
 * Builder UBL 2.1 del documento equivalente electrónico POS (anexo DE v1.0,
 * Fase 7A). Cada variante del §5 del anexo de la Fase 7 se arma desde una venta
 * real, se firma con el .p12 de prueba y se valida contra los XSD oficiales (la
 * caja de herramientas del DE v1.3 trae los MISMOS XSD que la FEV: mismos
 * SHA-256). El CUDE se recalcula con lo que la DIAN lee del propio XML y el PIN.
 *
 * Las tres extensiones del POS van en `ext:ExtensionContent`, que el XSD valida
 * en modo `lax`: su forma (nombres, pares Name/Value, literales) la prueban los
 * tests de contenido y de las reglas del §10.2, no el XSD.
 */
const CERT = { p12: p12DePrueba(), password: 'clave-de-prueba' };
const sha384 = (s: string) => createHash('sha384').update(s, 'utf8').digest('hex');

function armar(doc: DocumentoPosParaUbl, emisor: EmisorParaUbl = EMISOR_FISCAL): string {
  const p = prepararPosUbl(doc, emisor);
  return armarPosUbl({ ...p, codigoSeguridadSoftware: codigoSeguridadSoftware(SOFTWARE_ID, PIN, doc.fullNumber) });
}

// ── Lectura del XML (lo que lee la DIAN) ─────────────────────────────────────
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const NS_EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';

const parsear = (xml: string) => (new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document).documentElement;

function hijos(el: Element, ns: string, nombre: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === nombre) out.push(n as Element);
  }
  return out;
}
const hijo = (el: Element | undefined, ns: string, nombre: string) => (el ? hijos(el, ns, nombre)[0] : undefined);
const texto = (el: Element | undefined, nombre: string) => hijo(el, NS_CBC, nombre)?.textContent ?? '';
const centavosDe = (s: string) => aCentavos(Number(s));

/** Recalcula el CUDE con los valores del XML y el PIN (anexo DE v1.0 §14.1.3). */
function cudeDelXml(xml: string, pin: string): { uuid: string; recalculado: string } {
  const raiz = parsear(xml);
  const impuestos = { '01': 0, '04': 0, '03': 0 };
  for (const el of hijos(raiz, NS_CAC, 'TaxTotal')) {
    const sub = hijo(el, NS_CAC, 'TaxSubtotal')!;
    const codigo = texto(hijo(hijo(sub, NS_CAC, 'TaxCategory'), NS_CAC, 'TaxScheme'), 'ID');
    if (codigo in impuestos) impuestos[codigo as keyof typeof impuestos] = centavosDe(texto(el, 'TaxAmount'));
  }
  const total = hijo(raiz, NS_CAC, 'LegalMonetaryTotal');
  const nitDe = (rol: string) =>
    texto(hijo(hijo(hijo(raiz, NS_CAC, rol), NS_CAC, 'Party'), NS_CAC, 'PartyTaxScheme'), 'CompanyID');
  const recalculado = calcularCudePos({
    numero: texto(raiz, 'ID'),
    fecha: texto(raiz, 'IssueDate'),
    hora: texto(raiz, 'IssueTime'),
    valorBruto: centavosDe(texto(total, 'LineExtensionAmount')),
    impuestos,
    valorTotal: centavosDe(texto(total, 'PayableAmount')),
    nitEmisor: nitDe('AccountingSupplierParty'),
    numAdquiriente: nitDe('AccountingCustomerParty'),
    softwarePin: pin,
    tipoAmbiente: texto(raiz, 'ProfileExecutionID') as '1' | '2',
  });
  return { uuid: texto(raiz, 'UUID'), recalculado };
}

/** Contenido de cada `ext:ExtensionContent`, en orden: nombre del primer hijo. */
function extensiones(xml: string): Element[] {
  const raiz = parsear(xml);
  return hijos(hijo(raiz, NS_EXT, 'UBLExtensions')!, NS_EXT, 'UBLExtension').map(
    (u) => hijo(u, NS_EXT, 'ExtensionContent')!,
  );
}
const primerHijo = (el: Element): Element | undefined => {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return n as Element;
  return undefined;
};

/** Pares Name/Value de un grupo de extensión del POS, en orden. */
function pares(xml: string, grupo: string, info: string): Array<[string, string]> {
  const ext = extensiones(xml)
    .map(primerHijo)
    .find((e) => e?.localName === grupo);
  const el = ext ? hijo(ext, NS_INVOICE, info) : undefined;
  if (!el) return [];
  const out: Array<[string, string]> = [];
  let nombre = '';
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    if (e.localName === 'Name') nombre = e.textContent ?? '';
    if (e.localName === 'Value') out.push([nombre, e.textContent ?? '']);
  }
  return out;
}

// ── Variantes (§5 del anexo de la Fase 7) ───────────────────────────────────
const IVA_19 = linea({ name: 'Camisa', precio: 119_000, impuesto: 19_000, rate: 19 });
const CLIENTE_CC = {
  name: 'Ana Pérez',
  idNumber: '1020304050',
  docType: '13',
};
const VARIANTES: Record<string, DocumentoPosParaUbl> = {
  'consumidor final con IVA 19 %': documentoPos({ lines: [IVA_19], total: 119_000 }),
  'restaurante con INC 8 %': documentoPos({
    lines: [linea({ name: 'Bandeja paisa', precio: 32_400, impuesto: 2_400, kind: 'inc', rate: 8, qty: 2 })],
    total: 32_400,
  }),
  'excluido y exento': documentoPos({
    lines: [
      linea({ name: 'Leche', precio: 4_000, impuesto: 0, rate: 0, treatment: 'exento' }),
      linea({ name: 'Pan', precio: 3_000, impuesto: 0, rate: 0, treatment: 'excluido' }),
    ],
    total: 7_000,
  }),
  'INC de bolsas, propina y domicilio': documentoPos({
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
  'pago mixto: efectivo, débito, crédito y transferencia': documentoPos(
    { lines: [IVA_19], total: 119_000 },
    {
      pagos: [
        { metodo: 'cash', monto: 19_000, formaPago: '1' },
        { metodo: 'card', monto: 40_000, formaPago: '1', tipoTarjeta: 'debit', canal: 'datafono' },
        { metodo: 'card', monto: 40_000, formaPago: '1', tipoTarjeta: 'credit' },
        { metodo: 'transfer', monto: 20_000, formaPago: '1', canal: 'nequi' },
      ],
    },
  ),
  'con datos del cliente: cédula': documentoPos({ lines: [IVA_19], total: 119_000 }, { cliente: CLIENTE_CC }),
  'con datos del cliente: NIT con DV': documentoPos({ lines: [IVA_19], total: 119_000 }, { cliente: CLIENTE_NIT }),
  'fiado (crédito) en producción': documentoPos(
    { lines: [IVA_19], total: 119_000 },
    { cliente: CLIENTE_CC, ambiente: '1', pagos: [{ metodo: 'credit', monto: 119_000, formaPago: '2', vence: '2026-11-29' }] },
  ),
};

describe('POS UBL 2.1 · variantes contra el XSD oficial, firmadas', () => {
  it.each(Object.entries(VARIANTES))(
    '%s: firma, verifica, cumple el XSD y el CUDE del XML es el recalculado con el PIN',
    async (nombre, doc) => {
      const xml = armar(doc);
      const firmado = firmarXml(xml, CERT);
      expect(verificarFirma(firmado)).toEqual({ valida: true });
      const r = await validarXsdDian(firmado, `pos-${nombre.replace(/\W+/g, '-')}.xml`);
      expect(r.errores).toEqual([]);
      const { uuid, recalculado } = cudeDelXml(firmado, PIN);
      expect(uuid).toBe(doc.cufe);
      expect(recalculado).toBe(doc.cufe);
    },
    60_000,
  );
});

describe('POS UBL 2.1 · identificadores (§1.1)', () => {
  const doc = VARIANTES['consumidor final con IVA 19 %']!;
  const xml = armar(doc);

  it('InvoiceTypeCode 20, CustomizationID 10, ProfileID del POS sin espacio inicial', () => {
    expect(xml).toContain('<cbc:InvoiceTypeCode>20</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:CustomizationID>10</cbc:CustomizationID>');
    expect(xml).toContain('<cbc:ProfileID>DIAN 2.1: Documento Equivalente POS</cbc:ProfileID>');
    expect(PERFIL_POS.profileId.startsWith(' ')).toBe(false);
  });

  it('UUID con el CUDE (CUDE-SHA384) y el ambiente; QR con el CUDE', () => {
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUDE-SHA384">${doc.cufe}</cbc:UUID>`);
    expect(xml).toContain('<cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>');
    expect(xml).toContain(`<sts:QRCode>${dianVerificationUrl(doc.cufe!, '2')}</sts:QRCode>`);
    const prod = armar(VARIANTES['fiado (crédito) en producción']!);
    expect(prod).toMatch(/<cbc:UUID schemeID="1" schemeName="CUDE-SHA384">/);
  });

  it('SoftwareSecurityCode = SHA-384(SoftwareID + PIN + número) y el PIN no viaja', () => {
    expect(xml).toContain(`>${sha384(SOFTWARE_ID + PIN + doc.fullNumber)}</sts:SoftwareSecurityCode>`);
    expect(xml).not.toContain(PIN);
  });

  it('InvoiceControl con la resolución del POS y su prefijo; CorporateRegistrationScheme = prefijo (DEAJ50)', () => {
    expect(xml).toMatch(/<sts:Prefix>EPOS<\/sts:Prefix>\s*<sts:From>1<\/sts:From>\s*<sts:To>1000<\/sts:To>/);
    expect(xml).toContain('<cac:CorporateRegistrationScheme>\n          <cbc:ID>EPOS</cbc:ID>');
    expect(xml).toContain('<cbc:ID>EPOS1</cbc:ID>');
  });
});

describe('POS UBL 2.1 · extensiones', () => {
  const doc = VARIANTES['con datos del cliente: NIT con DV']!;
  const xml = armar(doc);

  it('orden: DianExtensions, la ranura de la firma (2.ª, política v2) y fabricante, beneficios y caja', () => {
    const contenidos = extensiones(xml);
    expect(contenidos).toHaveLength(5);
    expect(primerHijo(contenidos[0]!)?.localName).toBe('DianExtensions');
    expect(primerHijo(contenidos[1]!)).toBeUndefined();
    expect(contenidos.slice(2).map((c) => primerHijo(c)?.localName)).toEqual([
      'FabricanteSoftware',
      'BeneficiosComprador',
      'PuntoVenta',
    ]);
    // Sin prefijo, como el «Ejemplo POS.xml» oficial: heredan el namespace por defecto del Invoice.
    expect(contenidos.slice(2).map((c) => primerHijo(c)?.namespaceURI)).toEqual([NS_INVOICE, NS_INVOICE, NS_INVOICE]);
    expect(EXTENSIONES_POS).toEqual({
      fabricante: ['FabricanteSoftware', 'InformacionDelFabricanteDelSoftware'],
      beneficios: ['BeneficiosComprador', 'InformacionBeneficiosComprador'],
      caja: ['PuntoVenta', 'InformacionCajaVenta'],
    });
  });

  it('fabricante del software: NombreApellido, RazonSocial y NombreSoftware', () => {
    expect(pares(xml, 'FabricanteSoftware', 'InformacionDelFabricanteDelSoftware')).toEqual([
      ['NombreApellido', FABRICANTE.nombreApellido],
      ['RazonSocial', FABRICANTE.razonSocial],
      ['NombreSoftware', FABRICANTE.nombreSoftware],
    ]);
    const sinRazon = armar({ ...doc, fabricante: { ...FABRICANTE, razonSocial: undefined } });
    expect(pares(sinRazon, 'FabricanteSoftware', 'InformacionDelFabricanteDelSoftware').map(([n]) => n)).toEqual([
      'NombreApellido',
      'NombreSoftware',
    ]);
  });

  it('beneficios del comprador: código = documento, nombres y 0 puntos (BookiPos no tiene programa de puntos)', () => {
    expect(pares(xml, 'BeneficiosComprador', 'InformacionBeneficiosComprador')).toEqual([
      ['Codigo', '900108281'],
      ['NombresApellidos', 'Ópticas & Cía S.A.S.'],
      ['Puntos', '0'],
    ]);
    const cf = armar(VARIANTES['consumidor final con IVA 19 %']!);
    expect(pares(cf, 'BeneficiosComprador', 'InformacionBeneficiosComprador')).toEqual([
      ['Codigo', '222222222222'],
      ['NombresApellidos', 'Consumidor final'],
      ['Puntos', '0'],
    ]);
  });

  it('caja de venta: literales con tilde del anexo y SubTotal = LineExtensionAmount', () => {
    expect(pares(xml, 'PuntoVenta', 'InformacionCajaVenta')).toEqual([
      ['PlacaCaja', CAJA.placa],
      ['UbicaciónCaja', CAJA.ubicacion],
      ['Cajero', CAJA.cajero],
      ['TipoCaja', CAJA.tipo],
      ['CódigoVenta', CAJA.codigoVenta],
      ['SubTotal', '100000.00'],
    ]);
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="COP">100000.00</cbc:LineExtensionAmount>');
  });

  it('la firma queda en la 2.ª extensión y las del POS siguen intactas', () => {
    const firmado = firmarXml(xml, CERT);
    const contenidos = extensiones(firmado);
    expect(hijo(contenidos[1]!, NS_DS, 'Signature')).toBeDefined();
    expect(pares(firmado, 'PuntoVenta', 'InformacionCajaVenta')).toEqual(pares(xml, 'PuntoVenta', 'InformacionCajaVenta'));
  });
});

describe('POS UBL 2.1 · partes', () => {
  const cliente = (xml: string) =>
    xml.slice(xml.indexOf('<cac:AccountingCustomerParty>'), xml.indexOf('</cac:AccountingCustomerParty>'));

  it('consumidor final: 222222222222 tipo 13 en PartyIdentification y CompanyID, R-99-PN, tributo ZZ', () => {
    const c = cliente(armar(VARIANTES['consumidor final con IVA 19 %']!));
    expect(c).toContain('<cbc:AdditionalAccountID>2</cbc:AdditionalAccountID>');
    expect(c).toMatch(/<cac:PartyIdentification>\s*<cbc:ID [^>]*schemeName="13">222222222222<\/cbc:ID>/);
    expect(c).toMatch(/schemeName="13">222222222222<\/cbc:CompanyID>/);
    expect(c).toContain('<cbc:RegistrationName>Consumidor final</cbc:RegistrationName>');
    expect(c).toContain('>R-99-PN</cbc:TaxLevelCode>');
    expect(c).toMatch(/<cac:TaxScheme>\s*<cbc:ID>ZZ<\/cbc:ID>\s*<cbc:Name>No aplica<\/cbc:Name>/);
  });

  it('PartyIdentification SIEMPRE, también a la persona jurídica con NIT y DV', () => {
    const c = cliente(armar(VARIANTES['con datos del cliente: NIT con DV']!));
    expect(c).toContain('<cbc:AdditionalAccountID>1</cbc:AdditionalAccountID>');
    expect(c).toMatch(/<cac:PartyIdentification>\s*<cbc:ID [^>]*schemeID="3" schemeName="31">900108281<\/cbc:ID>/);
  });

  it('cliente con cédula sin ficha fiscal: basta nombre y documento (art. 19 par. 1)', () => {
    const c = cliente(armar(VARIANTES['con datos del cliente: cédula']!));
    expect(c).toMatch(/schemeName="13">1020304050<\/cbc:ID>/);
    expect(c).toContain('<cbc:RegistrationName>Ana Pérez</cbc:RegistrationName>');
    expect(c).toContain('>R-99-PN</cbc:TaxLevelCode>');
    expect(c).not.toContain('<cac:RegistrationAddress>');
  });

  it('emisor con su correo (DEAJ71 obligatorio en el POS)', () => {
    const xml = armar(VARIANTES['consumidor final con IVA 19 %']!);
    const emisor = xml.slice(xml.indexOf('<cac:AccountingSupplierParty>'), xml.indexOf('</cac:AccountingSupplierParty>'));
    expect(emisor).toContain('<cbc:ElectronicMail>facturacion@crunchy.co</cbc:ElectronicMail>');
    expect(emisor).toMatch(new RegExp(`schemeID="${DV}" schemeName="31">${NIT}</cbc:CompanyID>`));
  });
});

describe('POS UBL 2.1 · medios de pago', () => {
  it('pago mixto: un PaymentMeans por medio, en orden', () => {
    const xml = armar(VARIANTES['pago mixto: efectivo, débito, crédito y transferencia']!);
    const medios = [...xml.matchAll(/<cac:PaymentMeans>\s*<cbc:ID>(\d)<\/cbc:ID>\s*<cbc:PaymentMeansCode>(\w+)<\/cbc:PaymentMeansCode>/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    expect(medios).toEqual(['1:10', '1:49', '1:48', '1:47']);
  });

  it('fiado: forma 2 con PaymentDueDate (DEAN04)', () => {
    const xml = armar(VARIANTES['fiado (crédito) en producción']!);
    expect(xml).toMatch(
      /<cbc:ID>2<\/cbc:ID>\s*<cbc:PaymentMeansCode>1<\/cbc:PaymentMeansCode>\s*<cbc:PaymentDueDate>2026-11-29<\/cbc:PaymentDueDate>/,
    );
  });
});

describe('POS UBL 2.1 · reglas del §10.2 sobre el XML firmado', () => {
  it.each(Object.entries(VARIANTES))('%s', (_nombre, doc) => {
    const firmado = firmarXml(armar(doc), CERT);
    const raiz = parsear(firmado);
    // DEPD11/DEPD21: DianExtensions, Signature, fabricante, beneficios y caja.
    const grupos = extensiones(firmado).map((c) => primerHijo(c)?.localName);
    expect(grupos).toEqual(['DianExtensions', 'Signature', 'FabricanteSoftware', 'BeneficiosComprador', 'PuntoVenta']);
    // LineCountNumeric = número de InvoiceLine.
    expect(Number(texto(raiz, 'LineCountNumeric'))).toBe(hijos(raiz, NS_CAC, 'InvoiceLine').length);
    // Totales: Line = Σ líneas; Payable = TaxInclusive + cargos; TaxInclusive = Line + tributos de cabecera.
    const total = hijo(raiz, NS_CAC, 'LegalMonetaryTotal');
    const sumaLineas = hijos(raiz, NS_CAC, 'InvoiceLine').reduce((s, l) => s + centavosDe(texto(l, 'LineExtensionAmount')), 0);
    expect(centavosDe(texto(total, 'LineExtensionAmount'))).toBe(sumaLineas);
    const tributos = hijos(raiz, NS_CAC, 'TaxTotal').reduce((s, t) => s + centavosDe(texto(t, 'TaxAmount')), 0);
    expect(centavosDe(texto(total, 'TaxInclusiveAmount'))).toBe(sumaLineas + tributos);
    const cargos = centavosDe(texto(total, 'ChargeTotalAmount') || '0');
    expect(centavosDe(texto(total, 'PayableAmount'))).toBe(centavosDe(texto(total, 'TaxInclusiveAmount')) + cargos);
    expect(centavosDe(texto(total, 'PayableAmount'))).toBe(aCentavos(doc.payableAmount!));
    // SubTotal de la caja = LineExtensionAmount.
    const subtotal = pares(firmado, 'PuntoVenta', 'InformacionCajaVenta').find(([n]) => n === 'SubTotal')?.[1];
    expect(subtotal).toBe(texto(total, 'LineExtensionAmount'));
    // PaymentMeans 1..N y PaymentDueDate con forma 2.
    const pagos = hijos(raiz, NS_CAC, 'PaymentMeans');
    expect(pagos.length).toBeGreaterThanOrEqual(1);
    for (const p of pagos) if (texto(p, 'ID') === '2') expect(texto(p, 'PaymentDueDate')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // PartyIdentification del adquiriente siempre.
    const adq = hijo(hijo(raiz, NS_CAC, 'AccountingCustomerParty'), NS_CAC, 'Party');
    expect(hijo(adq, NS_CAC, 'PartyIdentification')).toBeDefined();
  });
});

describe('POS UBL 2.1 · se rechaza antes de leer el PIN', () => {
  const base = VARIANTES['con datos del cliente: NIT con DV']!;
  const preparar = (d: DocumentoPosParaUbl, e: EmisorParaUbl = EMISOR_FISCAL) => () => prepararPosUbl(d, e);

  it('un carácter de control en la caja, el fabricante o una línea, diciendo dónde', () => {
    expect(preparar({ ...base, cajaVenta: { ...CAJA, cajero: 'Laura\u0007' } })).toThrow(/cajaVenta\.cajero.*carácter de control/);
    expect(preparar({ ...base, fabricante: { ...FABRICANTE, nombreSoftware: 'Booki\u001b' } })).toThrow(/carácter de control/);
    const lines = base.lines.map((l) => ({ ...l, description: 'Camisa\u0000' }));
    expect(preparar({ ...base, lines })).toThrow(DocumentoUblInvalidoError);
  });

  it('un tipo que no es POS, o sin CUDE', () => {
    expect(preparar({ ...base, type: 'invoice' })).toThrow(/POS/);
    expect(preparar({ ...base, cufe: undefined })).toThrow(/CUDE/);
  });

  it('el emisor sin correo (DEAJ71 es rechazo en el POS)', () => {
    expect(preparar({ ...base, emisor: { ...base.emisor!, email: '  ' } })).toThrow(/correo/);
  });

  it('la caja incompleta o con un valor de más de 100 caracteres', () => {
    expect(preparar({ ...base, cajaVenta: undefined })).toThrow(/caja/);
    expect(preparar({ ...base, cajaVenta: { ...CAJA, placa: '' } })).toThrow(/placa/);
    expect(preparar({ ...base, cajaVenta: { ...CAJA, ubicacion: 'x'.repeat(101) } })).toThrow(/ubicación/);
  });

  it('el fabricante del software sin nombre o sin nombre del software', () => {
    expect(preparar({ ...base, fabricante: undefined })).toThrow(/fabricante/);
    expect(preparar({ ...base, fabricante: { ...FABRICANTE, nombreSoftware: ' ' } })).toThrow(/nombre del software/);
  });

  it('sin pagos, sin medio, con una forma inválida o un vencimiento mal escrito', () => {
    expect(preparar({ ...base, pagos: [] })).toThrow(/pago/);
    expect(preparar({ ...base, pagos: [{ monto: 1, formaPago: '1' }] })).toThrow(/medio/);
    expect(preparar({ ...base, pagos: [{ metodo: 'cash', formaPago: '3' }] })).toThrow(/forma/);
    expect(preparar({ ...base, pagos: [{ metodo: 'credit', formaPago: '2', vence: '29/11/2026' }] })).toThrow(/vencimiento/);
  });

  it('el código DIAN lo pone el builder: un pago guardado con «medio» no lo cambia', () => {
    const p = prepararPosUbl(
      { ...base, pagos: [{ metodo: 'transfer', formaPago: '1', canal: 'qr', medio: '42' } as never] },
      EMISOR_FISCAL,
    );
    expect(p.pagos).toEqual([{ formaPago: '1', medio: '47', vence: undefined }]);
  });

  it('un cliente con NIT cuyo DV no cuadra, o sin nombre', () => {
    expect(preparar({ ...base, adquiriente: { ...base.adquiriente!, nitDv: '9' } })).toThrow(/DV/);
    expect(preparar({ ...base, adquiriente: { ...base.adquiriente!, name: ' ' } })).toThrow(/nombre/);
  });

  it('un documento que no cuadra', () => {
    expect(preparar({ ...base, payableAmount: (base.payableAmount ?? 0) + 1 })).toThrow(/no cuadra/);
  });

  it('armarPosUbl sin pagos lanza aunque no pase por prepararPosUbl', () => {
    const p = prepararPosUbl(base, EMISOR_FISCAL);
    const codigo = codigoSeguridadSoftware(SOFTWARE_ID, PIN, base.fullNumber);
    expect(() => armarPosUbl({ ...p, codigoSeguridadSoftware: codigo, pagos: [] })).toThrow(DocumentoUblInvalidoError);
    expect(() =>
      armarPosUbl({ ...p, codigoSeguridadSoftware: codigo, emisor: { ...p.emisor, email: undefined } }),
    ).toThrow(/correo/);
  });
});

/**
 * El documento EXACTAMENTE como lo guarda la emisión del PR 7B
 * (`einvoicing.service.ts` → `pagosPos`, `cajaVentaPos`, `fabricanteDesdeEntorno`
 * de `emision-pos.ts`): pagos con el medio de BookiPos, fiado sin `vence`,
 * fabricante con `nit` y los `formaPago`/`medioPago` de cabecera de la FEV.
 */
describe('POS UBL 2.1 · el documento con la forma que guarda la emisión (7B)', () => {
  const comoLoGuarda7B = (): DocumentoPosParaUbl => {
    const d = documentoPos({ lines: [IVA_19], total: 119_000 }, { cliente: CLIENTE_CC });
    return {
      ...d,
      formaPago: '2',
      medioPago: '10',
      pagos: [
        { metodo: 'cash', monto: 10_000, formaPago: '1' },
        { metodo: 'transfer', monto: 5_000, formaPago: '1', canal: 'nequi' },
        { metodo: 'card', monto: 4_000, formaPago: '1', tipoTarjeta: 'debit' },
        { metodo: 'credit', monto: 100_000, formaPago: '2' },
      ],
      cajaVenta: { placa: 'SEDE-1', ubicacion: 'Calle 10 # 43-12', tipo: 'Caja principal', cajero: 'cajero@crunchy.co', codigoVenta: '000123' },
      fabricante: { nombreApellido: 'BookiPos', nombreSoftware: 'BookiPos', nit: '901234567' },
    };
  };

  it('prepararPosUbl → armarPosUbl → firma → XSD → CUDE, con pago mixto y fiado sin vencimiento', async () => {
    const doc = comoLoGuarda7B();
    const xml = armar(doc);
    const medios = [
      ...xml.matchAll(
        /<cac:PaymentMeans>\s*<cbc:ID>(\d)<\/cbc:ID>\s*<cbc:PaymentMeansCode>(\w+)<\/cbc:PaymentMeansCode>(?:\s*<cbc:PaymentDueDate>([\d-]+)<\/cbc:PaymentDueDate>)?/g,
      ),
    ].map((m) => [m[1], m[2], m[3]]);
    // Fiado sin vencimiento guardado: la fecha de emisión (como la FEV; a confirmar en habilitación).
    expect(medios).toEqual([
      ['1', '10', undefined],
      ['1', '47', undefined],
      ['1', '49', undefined],
      ['2', '1', doc.issueDate],
    ]);
    // El NIT del fabricante no va al XML: la extensión no lo tiene.
    expect(pares(xml, 'FabricanteSoftware', 'InformacionDelFabricanteDelSoftware')).toEqual([
      ['NombreApellido', 'BookiPos'],
      ['NombreSoftware', 'BookiPos'],
    ]);
    expect(xml).not.toContain('901234567');
    const firmado = firmarXml(xml, CERT);
    expect(verificarFirma(firmado)).toEqual({ valida: true });
    expect((await validarXsdDian(firmado, 'pos-forma-7b.xml')).errores).toEqual([]);
    const { uuid, recalculado } = cudeDelXml(firmado, PIN);
    expect(uuid).toBe(doc.cufe);
    expect(recalculado).toBe(doc.cufe);
  }, 60_000);
});
