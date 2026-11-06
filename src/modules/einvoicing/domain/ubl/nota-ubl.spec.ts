import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { calcularCude } from '../cufe';
import { aCentavos } from '../redondeo';
import { firmarXml, verificarFirma } from '../../infrastructure/firma/firma-xades';
import { p12DePrueba } from '../p12-de-prueba.test';
import { validarXsdDian } from './__fixtures__/validar-xsd.test';
import { CLIENTE_NIT, EMISOR_FISCAL, linea, PIN } from './__fixtures__/factura-de-prueba.test';
import { codigoSeguridadNota, documentoNota, FACTURA_REFERIDA, type OpcionesNota } from './__fixtures__/nota-de-prueba.test';
import { prepararNotaUbl, type DocumentoNotaParaUbl } from './nota-de-documento';
import {
  armarNotaCreditoUbl,
  armarNotaDebitoUbl,
  CONCEPTOS_NOTA_CREDITO,
  CONCEPTOS_NOTA_DEBITO,
  type EntradaNota,
} from './nota-ubl';
import { DocumentoUblInvalidoError } from './xml-ubl';

/**
 * Builder UBL 2.1 de la nota crédito y la nota débito (anexo FEV 1.9, Fase 6A).
 * Cada variante se firma con el .p12 de prueba, cumple el XSD oficial y su CUDE
 * se recalcula con los valores que la DIAN lee del propio XML (PIN del software).
 */
const CERT = { p12: p12DePrueba(), password: 'clave-de-prueba' };

function armar(doc: DocumentoNotaParaUbl): string {
  const n = prepararNotaUbl(doc, EMISOR_FISCAL);
  const completa = { ...n, codigoSeguridadSoftware: codigoSeguridadNota(doc.fullNumber) };
  return doc.type === 'credit_note' ? armarNotaCreditoUbl(completa) : armarNotaDebitoUbl(completa);
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

function cudeDelXml(xml: string, pin: string): { uuid: string; recalculado: string } {
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
  const total = hijo(raiz, NS_CAC, 'LegalMonetaryTotal') ?? hijo(raiz, NS_CAC, 'RequestedMonetaryTotal');
  const nitDe = (rol: string) =>
    texto(hijo(hijo(hijo(raiz, NS_CAC, rol)!, NS_CAC, 'Party')!, NS_CAC, 'PartyTaxScheme'), 'CompanyID');
  const recalculado = calcularCude({
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

// ── Variantes ────────────────────────────────────────────────────────────────
const IVA_19 = linea({ name: 'Camisa', precio: 119_000, impuesto: 19_000, rate: 19 });
const nota = (venta: Parameters<typeof documentoNota>[0], o: OpcionesNota) => documentoNota(venta, o);

const VARIANTES: Record<string, DocumentoNotaParaUbl> = {
  'NC anulación total con IVA': nota({ lines: [IVA_19], total: 119_000 }, { tipo: 'credit_note', concepto: '2', cliente: CLIENTE_NIT }),
  'NC anulación total, consumidor final': nota({ lines: [IVA_19], total: 119_000 }, { tipo: 'credit_note', concepto: '2' }),
  'NC devolución parcial por cantidad (2 de 5)': nota(
    { lines: [linea({ name: 'Camisa', precio: 238_000, impuesto: 38_000, rate: 19, qty: 2 })], total: 238_000 },
    { tipo: 'credit_note', concepto: '1', cliente: CLIENTE_NIT },
  ),
  'NC parcial por valor (ajuste de precio)': nota(
    { lines: [linea({ name: 'Camisa (ajuste de precio)', precio: 11_900, impuesto: 1_900, rate: 19 })], total: 11_900 },
    { tipo: 'credit_note', concepto: '4' },
  ),
  'NC descuento sin devolución': nota(
    { lines: [linea({ name: 'Descuento comercial', precio: 5_950, impuesto: 950, rate: 19 })], total: 5_950 },
    { tipo: 'credit_note', concepto: '3', cliente: CLIENTE_NIT },
  ),
  'NC con INC 8 %': nota(
    { lines: [linea({ name: 'Bandeja paisa', precio: 16_200, impuesto: 1_200, kind: 'inc', rate: 8 })], total: 16_200 },
    { tipo: 'credit_note', concepto: '1' },
  ),
  'NC de producto exento': nota(
    { lines: [linea({ name: 'Leche', precio: 4_000, impuesto: 0, rate: 0, treatment: 'exento' })], total: 4_000 },
    { tipo: 'credit_note', concepto: '2' },
  ),
  'NC sin referencia con periodo': nota(
    { lines: [IVA_19], total: 119_000 },
    {
      tipo: 'credit_note',
      concepto: '6',
      referencia: false,
      periodo: { desde: '2026-10-01', hasta: '2026-10-30' },
      cliente: CLIENTE_NIT,
    },
  ),
  'NC de ajuste del POS (94) anulación': nota(
    { lines: [IVA_19], total: 119_000 },
    { tipo: 'credit_note', concepto: '2', pos: true },
  ),
  'NC de ajuste del POS (94) devolución parcial con INC': nota(
    { lines: [linea({ name: 'Bandeja paisa', precio: 16_200, impuesto: 1_200, kind: 'inc', rate: 8 })], total: 16_200 },
    { tipo: 'credit_note', concepto: '1', pos: true, cliente: CLIENTE_NIT },
  ),
  'ND de ajuste del POS (93)': nota(
    { lines: [linea({ name: 'Ajuste de precio', precio: 11_900, impuesto: 1_900, rate: 19 })], total: 11_900 },
    { tipo: 'debit_note', concepto: '3', pos: true },
  ),
  'ND sin referencia con periodo': nota(
    { lines: [linea({ name: 'Intereses de mora', precio: 3_000, impuesto: 0, rate: 0, treatment: 'excluido' })], total: 3_000 },
    { tipo: 'debit_note', concepto: '1', referencia: false, periodo: { desde: '2026-10-05', hasta: '2026-10-20' } },
  ),
  'ND intereses (sin impuesto)': nota(
    { lines: [linea({ name: 'Intereses de mora', precio: 3_000, impuesto: 0, rate: 0, treatment: 'excluido' })], total: 3_000 },
    { tipo: 'debit_note', concepto: '1', cliente: CLIENTE_NIT },
  ),
  'ND ajuste de precio con IVA': nota(
    { lines: [linea({ name: 'Ajuste de precio', precio: 11_900, impuesto: 1_900, rate: 19 })], total: 11_900 },
    { tipo: 'debit_note', concepto: '3', cliente: CLIENTE_NIT },
  ),
  'ND gastos por cobrar con INC': nota(
    { lines: [linea({ name: 'Cobro adicional', precio: 5_400, impuesto: 400, kind: 'inc', rate: 8 })], total: 5_400 },
    { tipo: 'debit_note', concepto: '2' },
  ),
  'ND de producto exento': nota(
    { lines: [linea({ name: 'Leche', precio: 1_000, impuesto: 0, rate: 0, treatment: 'exento' })], total: 1_000 },
    { tipo: 'debit_note', concepto: '4' },
  ),
};

describe('notas UBL 2.1 · variantes contra el XSD oficial, firmadas', () => {
  it.each(Object.entries(VARIANTES))(
    '%s: firma, verifica, cumple el XSD y el CUDE del XML es el recalculado',
    async (nombre, doc) => {
      const xml = armar(doc);
      const firmado = firmarXml(xml, CERT);
      expect(verificarFirma(firmado)).toEqual({ valida: true });
      const r = await validarXsdDian(firmado, `${nombre.replace(/\W+/g, '-')}.xml`);
      expect(r.errores).toEqual([]);
      const { uuid, recalculado } = cudeDelXml(firmado, PIN);
      expect(uuid).toBe(doc.cufe);
      expect(recalculado).toBe(doc.cufe);
    },
    60_000,
  );
});

describe('notas UBL 2.1 · contenido', () => {
  const nc = armar(VARIANTES['NC anulación total con IVA']!);
  const nd = armar(VARIANTES['ND ajuste de precio con IVA']!);
  const sinRef = armar(VARIANTES['NC sin referencia con periodo']!);

  it('la nota crédito: raíz, CreditNoteTypeCode 91, CustomizationID 20, CUDE y sin InvoiceControl', () => {
    expect(nc).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(nc).toContain('<cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode>');
    expect(nc).toContain('<cbc:CustomizationID>20</cbc:CustomizationID>');
    expect(nc).toMatch(/<cbc:UUID schemeID="2" schemeName="CUDE-SHA384">[0-9a-f]{96}<\/cbc:UUID>/);
    expect(nc).not.toContain('InvoiceControl');
    expect(nc).toContain('<cac:CreditNoteLine>');
    expect(nc).toContain('<cbc:CreditedQuantity');
  });

  it('la nota débito: raíz DebitNote, CustomizationID 30, sin tipo, RequestedMonetaryTotal y DebitNoteLine', () => {
    expect(nd).toContain('<DebitNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2"');
    expect(nd).toContain('<cbc:CustomizationID>30</cbc:CustomizationID>');
    expect(nd).not.toContain('TypeCode');
    expect(nd).toContain('<cac:RequestedMonetaryTotal>');
    expect(nd).not.toContain('LegalMonetaryTotal');
    expect(nd).toContain('<cac:DebitNoteLine>');
    expect(nd).toContain('<cbc:DebitedQuantity');
  });

  it('DiscrepancyResponse y BillingReference con número, CUFE y fecha de la factura', () => {
    expect(nc).toContain(`<cbc:ReferenceID>${FACTURA_REFERIDA.numero}</cbc:ReferenceID>`);
    expect(nc).toContain('<cbc:ResponseCode>2</cbc:ResponseCode>');
    // CBF04/DBF04: el Description es el literal del catálogo; el motivo libre va en cbc:Note.
    expect(nc).toContain(`<cbc:Description>${CONCEPTOS_NOTA_CREDITO['2']}</cbc:Description>`);
    expect(nc).toContain('<cbc:Note>Corrección de la factura</cbc:Note>');
    expect(nc).toContain(`<cbc:UUID schemeName="CUFE-SHA384">${FACTURA_REFERIDA.cufe}</cbc:UUID>`);
    expect(nc).toContain(`<cbc:IssueDate>${FACTURA_REFERIDA.fecha}</cbc:IssueDate>`);
  });

  it('sin referencia: CustomizationID 22, InvoicePeriod y ningún BillingReference', () => {
    expect(sinRef).toContain('<cbc:CustomizationID>22</cbc:CustomizationID>');
    expect(sinRef).toContain('<cbc:StartDate>2026-10-01</cbc:StartDate>');
    expect(sinRef).not.toContain('BillingReference');
  });

  it('nota de ajuste del POS: tipo 94, CustomizationID 20, referencia al POS por su CUDE; la débita no lleva tipo', () => {
    const ajuste = armar(VARIANTES['NC de ajuste del POS (94) anulación']!);
    expect(ajuste).toContain('<cbc:CreditNoteTypeCode>94</cbc:CreditNoteTypeCode>');
    expect(ajuste).not.toContain('>91<');
    expect(ajuste).toContain('<cbc:CustomizationID>20</cbc:CustomizationID>');
    expect(ajuste).toContain('Nota de ajuste crédito al documento equivalente');
    expect(ajuste).toContain(`<cbc:UUID schemeName="CUDE-SHA384">${FACTURA_REFERIDA.cufe}</cbc:UUID>`);
    const debito = armar(VARIANTES['ND de ajuste del POS (93)']!);
    expect(debito).toContain('<DebitNote ');
    expect(debito).toContain('<cbc:CustomizationID>20</cbc:CustomizationID>');
    expect(debito).not.toContain('TypeCode');
  });

  it('ND sin referencia: CustomizationID 32', () => {
    expect(armar(VARIANTES['ND sin referencia con periodo']!)).toContain('<cbc:CustomizationID>32</cbc:CustomizationID>');
  });

  it('los valores nunca son negativos y los totales son la suma de las líneas', () => {
    for (const doc of Object.values(VARIANTES)) {
      const xml = armar(doc);
      expect(xml).not.toMatch(/>-\d/);
      const sumaLineas = [...xml.matchAll(/<cac:(?:Credit|Debit)NoteLine>[\s\S]*?<cbc:LineExtensionAmount currencyID="COP">([\d.]+)</g)]
        .map((m) => centavosDe(m[1]!))
        .reduce((a, b) => a + b, 0);
      const total = /<cbc:LineExtensionAmount currencyID="COP">([\d.]+)<\/cbc:LineExtensionAmount>\s*<cbc:TaxExclusiveAmount/.exec(xml);
      expect(centavosDe(total![1]!)).toBe(sumaLineas);
    }
  });

  it('el PIN no sale en el XML', () => {
    expect(nc).not.toContain(PIN);
    expect(nd).not.toContain(PIN);
  });
});

describe('notas UBL 2.1 · concepto, origen y esquema', () => {
  const base = VARIANTES['NC anulación total con IVA']!;
  const baseNd = VARIANTES['ND ajuste de precio con IVA']!;

  it('el Description de cada concepto es el literal del catálogo, nunca el motivo libre', () => {
    for (const [c, literal] of Object.entries(CONCEPTOS_NOTA_CREDITO)) {
      const xml = armar({ ...base, discrepancyCode: c, reason: 'motivo libre del cajero' });
      expect(xml).toContain(`<cbc:Description>${literal}</cbc:Description>`);
      expect(xml).not.toContain('<cbc:Description>motivo libre');
      expect(xml).toContain('<cbc:Note>motivo libre del cajero</cbc:Note>');
    }
    for (const [c, literal] of Object.entries(CONCEPTOS_NOTA_DEBITO)) {
      expect(armar({ ...baseNd, discrepancyCode: c })).toContain(`<cbc:Description>${literal}</cbc:Description>`);
    }
  });

  it('el concepto 4 de la nota débito es «Otros»', () => {
    expect(CONCEPTOS_NOTA_DEBITO['4']).toBe('Otros');
  });

  it('el Note va antes de DocumentCurrencyCode (orden del XSD) en crédito y débito', () => {
    for (const d of [base, baseNd]) {
      expect(armar(d)).toMatch(/<\/cbc:IssueTime>(?:\s*<cbc:CreditNoteTypeCode>\d+<\/cbc:CreditNoteTypeCode>)?\s*<cbc:Note>[^<]*<\/cbc:Note>\s*<cbc:DocumentCurrencyCode>/);
    }
  });

  it('el origen POS sale del tipo del documento referido y fija el esquema CUDE', () => {
    const pos = armar({ ...base, referenceType: 'pos' });
    expect(pos).toContain('<cbc:CreditNoteTypeCode>94</cbc:CreditNoteTypeCode>');
    expect(pos).toContain(`<cbc:UUID schemeName="CUDE-SHA384">${FACTURA_REFERIDA.cufe}</cbc:UUID>`);
    expect(armar({ ...base, referenceType: 'invoice' })).toContain('<cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode>');
  });

  it('un esquema que no coincide con el tipo del documento referido lanza', () => {
    expect(() => armar({ ...base, referenceType: 'pos', referenceScheme: 'CUFE-SHA384' })).toThrow(/debe ser CUDE-SHA384/);
    expect(() => armar({ ...base, referenceType: 'invoice', referenceScheme: 'CUDE-SHA384' })).toThrow(/debe ser CUFE-SHA384/);
    // Sin tipo referido, un CUDE no convierte la nota en ajuste del POS en silencio.
    expect(() => armar({ ...base, referenceScheme: 'CUDE-SHA384' })).toThrow(/debe ser CUFE-SHA384/);
    expect(() => armar({ ...base, referenceType: 'credit_note' })).toThrow(/no puede corregir/);
  });

  it('el builder rechaza un esquema fuera de CUFE/CUDE y uno que no es del origen', () => {
    const n = prepararNotaUbl(base, EMISOR_FISCAL);
    const completa = { ...n, codigoSeguridadSoftware: codigoSeguridadNota(base.fullNumber) };
    const conEsquema = (esquema: string) =>
      ({ ...completa, referencia: { ...completa.referencia!, esquema } }) as unknown as EntradaNota;
    expect(() => armarNotaCreditoUbl(conEsquema('"><x/>'))).toThrow(/algoritmo del código referido/);
    expect(() => armarNotaCreditoUbl(conEsquema('CUDE-SHA384'))).toThrow(/CUFE-SHA384 para una factura/);
  });
});

describe('notas UBL 2.1 · rechazos', () => {
  const base = VARIANTES['NC anulación total con IVA']!;
  const baseNd = VARIANTES['ND ajuste de precio con IVA']!;
  const lanza = (doc: DocumentoNotaParaUbl, patron: RegExp) => {
    expect(() => armar(doc)).toThrow(DocumentoUblInvalidoError);
    expect(() => armar(doc)).toThrow(patron);
  };

  it.each(['0', '7', '', 'x', 'constructor'])('concepto «%s» inválido en la nota crédito', (c) => {
    lanza({ ...base, discrepancyCode: c }, /concepto de corrección/);
  });
  it.each(['0', '5', '6', ''])('concepto «%s» inválido en la nota débito', (c) => {
    lanza({ ...baseNd, discrepancyCode: c }, /concepto de corrección/);
  });
  it('acepta todos los conceptos válidos', () => {
    for (const c of ['1', '2', '3', '4', '5', '6']) expect(() => armar({ ...base, discrepancyCode: c })).not.toThrow();
    for (const c of ['1', '2', '3', '4']) expect(() => armar({ ...baseNd, discrepancyCode: c })).not.toThrow();
  });
  it('sin descripción del concepto', () => {
    lanza({ ...base, reason: '   ' }, /descripción del concepto/);
    lanza({ ...baseNd, reason: undefined }, /descripción del concepto/);
  });
  it('sin referencia: el concepto 2 no se admite (CBF03a) y el periodo es obligatorio', () => {
    const periodo = { desde: '2026-10-01', hasta: '2026-10-30' };
    lanza({ ...base, referenceNumber: undefined, period: periodo }, /anulación, concepto 2/);
    lanza({ ...base, referenceNumber: undefined, discrepancyCode: '3' }, /periodo/);
    lanza({ ...baseNd, referenceNumber: undefined }, /periodo/);
    lanza({ ...VARIANTES['NC sin referencia con periodo']!, period: undefined }, /periodo/);
  });
  it('el periodo sin referencia: máximo 30 días y dentro de un mes', () => {
    const sin = VARIANTES['NC sin referencia con periodo']!;
    lanza({ ...sin, period: { desde: '2026-10-01', hasta: '2026-10-31' } }, /máximo 30 días/);
    lanza({ ...sin, period: { desde: '2026-10-20', hasta: '2026-11-05' } }, /mismo mes/);
    lanza({ ...sin, period: { desde: '2026-10-20', hasta: '2026-10-01' } }, /inicio posterior/);
    expect(() => armar({ ...sin, period: { desde: '2026-11-01', hasta: '2026-11-30' } })).not.toThrow();
  });
  it('la nota de ajuste del POS siempre lleva referencia y su concepto 5 (otros) es válido', () => {
    const pos = VARIANTES['NC de ajuste del POS (94) anulación']!;
    lanza({ ...pos, referenceNumber: undefined, period: { desde: '2026-10-01', hasta: '2026-10-30' } }, /siempre lleva la referencia al documento POS/);
    expect(() => armar({ ...pos, discrepancyCode: '5' })).not.toThrow();
    lanza({ ...pos, discrepancyCode: '6' }, /concepto de corrección/);
  });
  it('referencia incompleta: CUFE o fecha mal formados', () => {
    lanza({ ...base, referenceCufe: 'abc' }, /CUFE\/CUDE del documento referido/);
    lanza({ ...base, referenceIssueDate: '30/10/2026' }, /fecha del documento referido/);
  });
  it('un valor negativo lanza', () => {
    const l = base.lines[0]!;
    lanza({ ...base, lines: [{ ...l, base: -1 }] }, /no negativos|no cuadra/);
    lanza({ ...base, lines: [{ ...l, taxAmount: -19_000 }] }, /no negativos|no cuadra/);
  });
  it('totales que no son la suma de las líneas lanzan', () => {
    lanza({ ...base, payableAmount: (base.payableAmount ?? 0) + 1 }, /no cuadra/);
  });
  it('una nota que no es nota no se prepara', () => {
    expect(() => prepararNotaUbl({ ...base, type: 'invoice' }, EMISOR_FISCAL)).toThrow(/notas crédito y débito/);
  });
  it('el builder no acepta una nota por valor cero', () => {
    const n = { ...prepararNotaUbl(base, EMISOR_FISCAL), codigoSeguridadSoftware: codigoSeguridadNota(base.fullNumber) };
    const cero = { ...n, lineas: [{ ...n.lineas[0]!, base: 0, taxAmount: 0, total: 0 }], totales: { ...n.totales, taxableBase: 0, taxExclusiveAmount: 0, ivaTotal: 0, taxInclusiveAmount: 0, payableAmount: 0 } };
    expect(() => armarNotaCreditoUbl(cero as EntradaNota)).toThrow(/valor cero/);
  });
});
