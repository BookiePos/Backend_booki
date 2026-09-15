import { describe, it, expect } from 'vitest';
import { parseUblInvoice, UblInvoiceError } from './ubl-invoice';

/**
 * Lectura del XML de la factura electrónica DIAN (UBL 2.1).
 *
 * La factura de abajo sigue la estructura del estándar con los datos de una
 * compra real de Crunchy Munch (Merquesos): dos renglones con IVA distinto,
 * retención en la fuente y pago a crédito. El cliente trae OTRO nombre y OTRO
 * NIT a propósito: es el error más fácil de cometer, leer al comprador como si
 * fuera el proveedor.
 */
const INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>
    <sts:DianExtensions xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1">
      <sts:InvoiceControl><sts:InvoiceAuthorization>18764093322564</sts:InvoiceAuthorization></sts:InvoiceControl>
    </sts:DianExtensions>
  </ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:ID>EL220497</cbc:ID>
  <cbc:UUID schemeName="CUFE-SHA384">c4329b4c1677066d</cbc:UUID>
  <cbc:IssueDate>2026-09-14</cbc:IssueDate>
  <cbc:IssueTime>08:46:56-05:00</cbc:IssueTime>
  <cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>2</cbc:LineCountNumeric>
  <cac:AccountingSupplierParty>
    <cbc:AdditionalAccountID>2</cbc:AdditionalAccountID>
    <cac:Party>
      <cac:PartyName><cbc:Name>MERQUESOS</cbc:Name></cac:PartyName>
      <cac:PhysicalLocation><cac:Address>
        <cbc:CityName>Rionegro</cbc:CityName>
        <cac:AddressLine><cbc:Line>CR 46 54 24</cbc:Line></cac:AddressLine>
      </cac:Address></cac:PhysicalLocation>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>RUBEN DARIO VALENCIA GARCIA</cbc:RegistrationName>
        <cbc:CompanyID schemeAgencyID="195" schemeID="3" schemeName="31">15428370</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:Contact><cbc:Telephone>3105175015</cbc:Telephone></cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>KAREN JULIETH RAMIREZ MONTOYA</cbc:RegistrationName>
        <cbc:CompanyID schemeName="13">1030540823</cbc:CompanyID>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:ID>2</cbc:ID>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>2026-10-14</cbc:PaymentDueDate>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="COP">4647.62</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="COP">92952.40</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="COP">4647.62</cbc:TaxAmount>
      <cac:TaxCategory><cbc:Percent>5.00</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:WithholdingTaxTotal>
    <cbc:TaxAmount currencyID="COP">2324.00</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="COP">92952.40</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="COP">2324.00</cbc:TaxAmount>
      <cac:TaxCategory><cbc:Percent>2.50</cbc:Percent><cac:TaxScheme><cbc:ID>06</cbc:ID><cbc:Name>ReteRenta</cbc:Name></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:WithholdingTaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">212952.40</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="COP">92952.40</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="COP">217600.02</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="COP">217600.02</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="94">8.000000</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">92952.40</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">4647.62</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">92952.40</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">4647.62</cbc:TaxAmount>
        <cac:TaxCategory><cbc:Percent>5.00</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>AZUCAR MORENA 2.5KG</cbc:Description>
      <cac:SellersItemIdentification><cbc:ID>30003</cbc:ID></cac:SellersItemIdentification>
      <cac:StandardItemIdentification><cbc:ID schemeID="010" schemeName="GTIN">7702001000011</cbc:ID></cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="COP">11619.05</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="94">1.000000</cbc:BaseQuantity>
    </cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="94">240.000000</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">120000.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">120000.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">0.00</cbc:TaxAmount>
        <cac:TaxCategory><cbc:Percent>0.00</cbc:Percent><cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>HUEVO AA MEDIANO</cbc:Description>
      <cac:StandardItemIdentification><cbc:ID schemeID="999">12002</cbc:ID></cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="COP">500.00</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="94">1.000000</cbc:BaseQuantity>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

/** El contenedor que llega al comprador por correo, con la factura como CDATA. */
const ATTACHED = `<?xml version="1.0" encoding="UTF-8"?>
<AttachedDocument xmlns="urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:ID>EL220497</cbc:ID>
  <cac:SenderParty><cac:PartyTaxScheme><cbc:RegistrationName>RUBEN DARIO VALENCIA GARCIA</cbc:RegistrationName></cac:PartyTaxScheme></cac:SenderParty>
  <cac:Attachment>
    <cac:ExternalReference>
      <cbc:MimeCode>text/xml</cbc:MimeCode>
      <cbc:EncodingCode>UTF-8</cbc:EncodingCode>
      <cbc:Description><![CDATA[${INVOICE}]]></cbc:Description>
    </cac:ExternalReference>
  </cac:Attachment>
  <cac:ParentDocumentLineReference>
    <cbc:LineID>1</cbc:LineID>
    <cac:DocumentReference>
      <cbc:ID>EL220497</cbc:ID>
      <cac:Attachment><cac:ExternalReference>
        <cbc:Description><![CDATA[<ApplicationResponse><cbc:ID>123</cbc:ID></ApplicationResponse>]]></cbc:Description>
      </cac:ExternalReference></cac:Attachment>
    </cac:DocumentReference>
  </cac:ParentDocumentLineReference>
</AttachedDocument>`;

describe('parseUblInvoice', () => {
  it('lee el contenedor del correo: el proveedor es el emisor, nunca el cliente', () => {
    const invoice = parseUblInvoice(ATTACHED);

    expect(invoice.supplier).toEqual({
      name: 'RUBEN DARIO VALENCIA GARCIA',
      docNumber: '15428370',
      docType: 'NIT',
      phone: '3105175015',
      address: 'CR 46 54 24',
      city: 'Rionegro',
    });
  });

  it('toma número, fechas y forma de pago del documento', () => {
    expect(parseUblInvoice(ATTACHED).invoice).toEqual({
      number: 'EL220497',
      issueDate: '2026-09-14',
      dueDate: '2026-10-14',
      paymentTerms: 'credito',
    });
  });

  it('lee los renglones con números exactos: "8.000000" son 8, no ocho millones', () => {
    const { lines } = parseUblInvoice(ATTACHED);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      description: 'AZUCAR MORENA 2.5KG',
      qty: 8,
      unit: '94',
      unitCost: 11619,
      ivaRate: 5,
      lineTotal: 97600,
      code: '30003',
      barcode: '7702001000011',
    });
    expect(lines[1]).toMatchObject({
      description: 'HUEVO AA MEDIANO',
      qty: 240,
      unitCost: 500,
      ivaRate: 0,
      lineTotal: 120000,
      code: '12002',
    });
    expect(lines[1]?.barcode).toBeUndefined();
  });

  it('suma IVA y retenciones y toma el total a pagar', () => {
    expect(parseUblInvoice(ATTACHED).totals).toEqual({
      subtotal: 212952,
      iva: 4648,
      retentions: 2324,
      total: 217600,
    });
  });

  it('también lee la factura suelta, sin contenedor', () => {
    const suelta = parseUblInvoice(INVOICE);
    const contenedor = parseUblInvoice(ATTACHED);

    expect(suelta).toEqual(contenedor);
  });

  it('no depende de los prefijos que declare el proveedor', () => {
    const sinPrefijos = INVOICE.replace(/<(\/?)(cac|cbc|ext|sts):/g, '<$1');

    expect(parseUblInvoice(sinPrefijos).supplier.docNumber).toBe('15428370');
    expect(parseUblInvoice(sinPrefijos).lines).toHaveLength(2);
  });

  it('rechaza notas crédito con un mensaje claro', () => {
    const nota = INVOICE.replace(/<(\/?)Invoice([\s>])/g, '<$1CreditNote$2');

    expect(() => parseUblInvoice(nota)).toThrow(UblInvoiceError);
    expect(() => parseUblInvoice(nota)).toThrow(/nota crédito/);
  });

  it('rechaza un XML que no es una factura de la DIAN', () => {
    expect(() => parseUblInvoice('<?xml version="1.0"?><Pedido><ID>1</ID></Pedido>')).toThrow(
      /no es una factura electrónica/,
    );
  });

  it('rechaza un contenedor que no trae la factura adentro', () => {
    const vacio = ATTACHED.replace(/<!\[CDATA\[[\s\S]*?\]\]>/, '');

    expect(() => parseUblInvoice(vacio)).toThrow(/no trae la factura/);
  });
});
