import { leerApplicationResponseXml } from './lectura-application-response';
import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import {
  applicationResponseDe,
  construirAttachedDocument,
  ErrorEntrega,
  type DatosAttached,
} from './attached-document';
import { firmarXml, verificarFirma } from '../../infrastructure/firma/firma-xades';
import { p12DePrueba } from '../p12-de-prueba.test';

const CUFE = '8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4';

const NS =
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
  ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
  ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
  ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"' +
  ' xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';

const PTS_EMISOR =
  '<cac:PartyTaxScheme><cbc:RegistrationName>Crunchy &amp; Munch SAS</cbc:RegistrationName>' +
  '<cbc:CompanyID schemeAgencyID="195" schemeID="7" schemeName="31">900123456</cbc:CompanyID>' +
  '<cbc:TaxLevelCode listName="48">R-99-PN</cbc:TaxLevelCode>' +
  '<cac:RegistrationAddress><cbc:ID>05001</cbc:ID></cac:RegistrationAddress>' +
  '<cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>';

const PTS_CLIENTE =
  '<cac:PartyTaxScheme><cbc:RegistrationName>Consumidor final</cbc:RegistrationName>' +
  '<cbc:CompanyID schemeAgencyID="195" schemeName="13">222222222222</cbc:CompanyID>' +
  '<cbc:TaxLevelCode listName="48">R-99-PN</cbc:TaxLevelCode>' +
  '<cac:TaxScheme><cbc:ID>ZZ</cbc:ID><cbc:Name>No aplica</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>';

/** Factura «firmada» mínima: lo que importa es que traiga el CUFE, las partes y una firma. */
const FACTURA =
  `<?xml version="1.0" encoding="UTF-8"?><Invoice ${NS}>` +
  '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><ds:Signature Id="x"/></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>' +
  `<cbc:ID>SETP990000001</cbc:ID><cbc:UUID schemeName="CUFE-SHA384">${CUFE}</cbc:UUID>` +
  `<cac:AccountingSupplierParty><cac:Party>${PTS_EMISOR}</cac:Party></cac:AccountingSupplierParty>` +
  `<cac:AccountingCustomerParty><cac:Party>${PTS_CLIENTE}</cac:Party></cac:AccountingCustomerParty>` +
  '<cbc:Note>texto con ]]> adentro</cbc:Note></Invoice>';

const AR =
  '\uFEFF<?xml version="1.0" encoding="UTF-8"?><ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"' +
  ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
  ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">' +
  `<cac:DocumentResponse><cac:Response><cbc:ResponseCode>02</cbc:ResponseCode></cac:Response>` +
  `<cac:DocumentReference><cbc:UUID schemeName="CUFE-SHA384">${CUFE.toUpperCase()}</cbc:UUID></cac:DocumentReference>` +
  '</cac:DocumentResponse></ApplicationResponse>';

const base = (cambios: Partial<DatosAttached> = {}): DatosAttached => ({
  fullNumber: 'SETP990000001',
  cufe: CUFE,
  issueDate: '2026-10-30',
  tipoAmbiente: '2',
  emisor: { nombre: 'Crunchy & Munch SAS', nit: '900123456', dv: '7', tipoDocumento: '31' },
  adquiriente: { nombre: 'Consumidor final', nit: '222222222222', tipoDocumento: '13' },
  xmlFactura: FACTURA,
  applicationResponse: AR,
  validadoAt: new Date('2026-10-30T20:15:00Z'),
  ahora: new Date('2026-10-30T20:16:30Z'),
  ...cambios,
});

const parsear = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
const texto = (doc: Document, local: string, i = 0) =>
  doc.getElementsByTagNameNS('*', local)[i]?.textContent ?? null;

describe('AttachedDocument (anexo FEV 1.9)', () => {
  it('contenedor con la factura y la ApplicationResponse en CDATA, ranura de firma vacía', () => {
    const xml = construirAttachedDocument(base());
    const doc = parsear(xml);
    expect(doc.documentElement.localName).toBe('AttachedDocument');
    expect(doc.documentElement.namespaceURI).toBe('urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2');
    expect(texto(doc, 'ProfileExecutionID')).toBe('2');
    expect(texto(doc, 'ParentDocumentID')).toBe('SETP990000001');
    expect(texto(doc, 'IssueDate')).toBe('2026-10-30');
    expect(texto(doc, 'IssueTime')).toBe('15:16:30-05:00');
    // Las dos descripciones devuelven los XML intactos (el `]]>` partido se recompone).
    expect(texto(doc, 'Description', 0)).toBe(FACTURA);
    expect(texto(doc, 'Description', 1)).toBe(AR.replace(/^\uFEFF/, ''));
    expect(texto(doc, 'UUID')).toBe(CUFE);
    expect(texto(doc, 'ValidationResultCode')).toBe('02');
    expect(texto(doc, 'ValidationDate')).toBe('2026-10-30');
    expect(texto(doc, 'ValidationTime')).toBe('15:15:00-05:00');
    const contenido = doc.getElementsByTagNameNS('*', 'ExtensionContent')[0]!;
    expect(contenido.childNodes.length).toBe(0);
    // La firma de la factura viaja como texto, no como elemento del contenedor.
    expect(doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature').length).toBe(0);
  });

  it('las partes salen del PartyTaxScheme de la factura firmada, sin la dirección', () => {
    const doc = parsear(construirAttachedDocument(base()));
    const sender = doc.getElementsByTagNameNS('*', 'SenderParty')[0]!;
    const receiver = doc.getElementsByTagNameNS('*', 'ReceiverParty')[0]!;
    expect(sender.getElementsByTagNameNS('*', 'RegistrationName')[0]!.textContent).toBe('Crunchy & Munch SAS');
    expect(sender.getElementsByTagNameNS('*', 'RegistrationAddress').length).toBe(0);
    expect(sender.getElementsByTagNameNS('*', 'CompanyID')[0]!.textContent).toBe('900123456');
    expect(receiver.getElementsByTagNameNS('*', 'CompanyID')[0]!.textContent).toBe('222222222222');
  });

  it('si la factura no trae PartyTaxScheme legible, arma las partes con los datos del documento', () => {
    const sinPartes = FACTURA.replace(PTS_EMISOR, '').replace(PTS_CLIENTE, '');
    const doc = parsear(construirAttachedDocument(base({ xmlFactura: sinPartes })));
    const sender = doc.getElementsByTagNameNS('*', 'SenderParty')[0]!;
    expect(sender.getElementsByTagNameNS('*', 'RegistrationName')[0]!.textContent).toBe('Crunchy & Munch SAS');
    const id = sender.getElementsByTagNameNS('*', 'CompanyID')[0]!;
    expect(id.textContent).toBe('900123456');
    expect(id.getAttribute('schemeID')).toBe('7');
    expect(id.getAttribute('schemeName')).toBe('31');
  });

  it('se firma con el perfil XAdES de siempre y la firma verifica', () => {
    const xml = construirAttachedDocument(base());
    const firmado = firmarXml(xml, { p12: p12DePrueba(), password: 'clave-de-prueba' });
    expect(verificarFirma(firmado)).toEqual({ valida: true });
  });

  it('rechaza una factura que no es la del CUFE', () => {
    expect(() => construirAttachedDocument(base({ cufe: 'a'.repeat(96) }))).toThrow(ErrorEntrega);
    expect(() => construirAttachedDocument(base({ xmlFactura: '<Otra/>' }))).toThrow(ErrorEntrega);
  });

  it('rechaza una ApplicationResponse de otro documento o que no es una aceptación', () => {
    expect(() =>
      construirAttachedDocument(base({ applicationResponse: AR.replace(CUFE.toUpperCase(), 'B'.repeat(96)) })),
    ).toThrow(/otro documento/);
    expect(() =>
      construirAttachedDocument(base({ applicationResponse: AR.replace('>02<', '>04<') })),
    ).toThrow(/aceptación/);
    expect(() => construirAttachedDocument(base({ applicationResponse: '<Nada/>' }))).toThrow(ErrorEntrega);
  });

  it('la lectura de la ApplicationResponse ignora comentarios, exige el namespace UBL y no es cuadrática', () => {
    const otro = 'b'.repeat(96);
    const real = (uuid: string, ns = 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2') =>
      `<ApplicationResponse xmlns="${ns}" xmlns:cac="a" xmlns:cbc="c"><cac:DocumentResponse><cac:Response><cbc:ResponseCode>02</cbc:ResponseCode></cac:Response>` +
      `<cac:DocumentReference><cbc:UUID>${uuid}</cbc:UUID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
    expect(leerApplicationResponseXml(real(otro))).toEqual({ codigo: '02', cufe: otro });
    const engano = real(otro).replace(
      '<cac:DocumentResponse>',
      `<!--<cac:DocumentResponse><cac:DocumentReference><cbc:UUID>${CUFE}</cbc:UUID></cac:DocumentReference></cac:DocumentResponse>--><cac:DocumentResponse>`,
    );
    expect(leerApplicationResponseXml(engano)?.cufe).toBe(otro);
    expect(leerApplicationResponseXml(real(CUFE, 'urn:falso'))).toBeNull();
    const pesado = real(CUFE).replace('<cac:DocumentResponse>', `<!--${'<DocumentResponse '.repeat(55_000)}--><cac:DocumentResponse>`);
    const t0 = Date.now();
    expect(leerApplicationResponseXml(pesado)?.cufe).toBe(CUFE);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('applicationResponseDe: solo un XML de ApplicationResponse en base64; si no, null (el hueco)', () => {
    expect(applicationResponseDe(undefined)).toBeNull();
    expect(applicationResponseDe({ ok: true, codigo: '00' })).toBeNull();
    expect(applicationResponseDe({ applicationResponse: 123 })).toBeNull();
    expect(applicationResponseDe({ applicationResponse: Buffer.from('<Invoice/>').toString('base64') })).toBeNull();
    expect(applicationResponseDe({ applicationResponse: Buffer.from(AR).toString('base64') })).toBe(AR);
  });
});
