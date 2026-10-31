/**
 * AttachedDocument de la entrega al adquiriente (anexo FEV 1.9, «documento
 * adjunto»). Fase 5B.
 *
 * Cuando la DIAN acepta una factura, el emisor le entrega al cliente un
 * contenedor UBL 2.1 `<AttachedDocument>` que lleva, en CDATA, la factura
 * firmada TAL CUAL se transmitió y la ApplicationResponse con la que la DIAN la
 * validó. El contenedor lo firma el emisor con el mismo perfil XAdES-EPES (una
 * sola `UBLExtension`) y viaja en un ZIP junto con la representación gráfica.
 *
 * Puro: arma el XML SIN firmar. Lo que identifica al documento (número, CUFE,
 * fecha, ambiente) sale del documento guardado, y las partes, del
 * `PartyTaxScheme` de la propia factura firmada; así el contenedor no contradice
 * lo que la DIAN validó. Se comprueba que la factura sea la del CUFE y que la
 * ApplicationResponse sea una ACEPTACIÓN (02) de ese mismo CUFE.
 *
 * Basado en la referencia de AlíaCorp (`apps/erp/lib/dian/attached-document.ts`).
 */

export const VALIDADOR_DIAN = 'Unidad Especial Dirección de Impuestos y Aduanas Nacionales';
/** ResponseCode de la ApplicationResponse: «documento validado por la DIAN». */
export const CODIGO_DOCUMENTO_VALIDADO = '02';

export const NS_ATTACHED = 'urn:oasis:names:specification:ubl:schema:xsd:AttachedDocument-2';
const NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const NS_EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';

/** Por qué no se pudo armar la entrega. El `codigo` es estable (se guarda en el documento). */
export class ErrorEntrega extends Error {
  constructor(
    readonly codigo:
      | 'XML_NO_CORRESPONDE'
      | 'AR_ILEGIBLE'
      | 'AR_OTRO_DOCUMENTO'
      | 'AR_NO_ACEPTADA',
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorEntrega';
  }
}

export interface ParteAttached {
  nombre: string;
  /** Número de identificación (NIT sin DV, o la cédula). */
  nit: string;
  dv?: string;
  /** Código DIAN del tipo de documento (31 = NIT, 13 = CC…). */
  tipoDocumento?: string;
}

export interface DatosAttached {
  fullNumber: string;
  cufe: string;
  /** Fecha de emisión de la factura (YYYY-MM-DD). */
  issueDate: string;
  tipoAmbiente: string;
  emisor: ParteAttached;
  adquiriente: ParteAttached;
  /** La factura firmada tal como se transmitió. */
  xmlFactura: string;
  /** La ApplicationResponse de la DIAN (XML). */
  applicationResponse: string;
  /** Cuándo respondió la DIAN; sin él, `ahora`. */
  validadoAt?: Date;
  ahora: Date;
}

/** Fecha y hora de Bogotá (UTC-5, sin horario de verano). */
function bogota(d: Date): { fecha: string; hora: string } {
  const iso = new Date(d.getTime() - 5 * 3_600_000).toISOString();
  return { fecha: iso.slice(0, 10), hora: `${iso.slice(11, 19)}-05:00` };
}

function escapar(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** CDATA a prueba de `]]>` dentro del contenido. */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function sinBom(s: string): string {
  return s.replace(/^\uFEFF/, '').trim();
}

/** Bloque `<cac:tag …>…</cac:tag>`; '' si no está. Solo con el prefijo `cac:` del UBL. */
function bloqueCac(xml: string, tag: string): string {
  return xml.match(new RegExp(`<cac:${tag}[\\s>][\\s\\S]*?</cac:${tag}>`))?.[0] ?? '';
}

/**
 * El `PartyTaxScheme` de una parte de la factura, sin la dirección (el
 * contenedor solo lleva identificación y régimen). '' si no es legible.
 */
function partyTaxSchemeDe(xmlFactura: string, parte: string): string {
  const pts = bloqueCac(bloqueCac(xmlFactura, parte), 'PartyTaxScheme');
  if (!pts.includes('<cbc:CompanyID')) return '';
  return pts.replace(/<cac:RegistrationAddress>[\s\S]*?<\/cac:RegistrationAddress>/, '');
}

/** Respaldo: el `PartyTaxScheme` armado con los datos congelados del documento. */
function partyTaxSchemeDeDatos(p: ParteAttached): string {
  const tipo = p.tipoDocumento ?? '31';
  const dv = tipo === '31' && p.dv ? ` schemeID="${escapar(p.dv)}"` : '';
  return (
    `<cac:PartyTaxScheme><cbc:RegistrationName>${escapar(p.nombre)}</cbc:RegistrationName>` +
    `<cbc:CompanyID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"${dv} schemeName="${escapar(tipo)}">` +
    `${escapar(p.nit)}</cbc:CompanyID>` +
    `<cbc:TaxLevelCode listName="48">R-99-PN</cbc:TaxLevelCode>` +
    `<cac:TaxScheme><cbc:ID>ZZ</cbc:ID><cbc:Name>No aplica</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>`
  );
}

/** Lo que importa de la ApplicationResponse: el código y el CUFE del documento al que responde. */
function leerApplicationResponse(ar: string): { codigo: string; cufe: string } {
  if (!/<(?:\w+:)?ApplicationResponse[\s>]/.test(ar)) {
    throw new ErrorEntrega('AR_ILEGIBLE', 'La respuesta guardada de la DIAN no es una ApplicationResponse.');
  }
  const respuesta = ar.match(/<(?:\w+:)?DocumentResponse[\s>][\s\S]*?<\/(?:\w+:)?DocumentResponse>/)?.[0] ?? '';
  const codigo = respuesta.match(/<(?:\w+:)?ResponseCode[^>]*>\s*([^<]+?)\s*</)?.[1];
  const referencia = respuesta.match(/<(?:\w+:)?DocumentReference[\s>][\s\S]*?<\/(?:\w+:)?DocumentReference>/)?.[0] ?? '';
  const cufe = referencia.match(/<(?:\w+:)?UUID[^>]*>\s*([^<]+?)\s*</)?.[1];
  if (!codigo || !cufe) {
    throw new ErrorEntrega('AR_ILEGIBLE', 'La ApplicationResponse no trae el código ni el documento validado.');
  }
  return { codigo, cufe };
}

/**
 * Arma el AttachedDocument SIN firmar (la ranura de la firma queda vacía, en la
 * única `UBLExtension`). Lanza `ErrorEntrega` si la factura o la respuesta no
 * corresponden al documento o si la DIAN no lo aceptó.
 */
export function construirAttachedDocument(d: DatosAttached): string {
  const factura = sinBom(d.xmlFactura);
  const cufe = d.cufe.trim();
  if (!cufe || !/<(?:\w+:)?Invoice[\s>]/.test(factura) || !factura.includes(cufe)) {
    throw new ErrorEntrega('XML_NO_CORRESPONDE', 'El XML guardado no es la factura de este CUFE.');
  }
  const ar = sinBom(d.applicationResponse);
  const validacion = leerApplicationResponse(ar);
  if (validacion.cufe.toLowerCase() !== cufe.toLowerCase()) {
    throw new ErrorEntrega('AR_OTRO_DOCUMENTO', 'La ApplicationResponse guardada corresponde a otro documento.');
  }
  if (validacion.codigo !== CODIGO_DOCUMENTO_VALIDADO) {
    throw new ErrorEntrega(
      'AR_NO_ACEPTADA',
      `La ApplicationResponse no es una aceptación (código ${validacion.codigo.slice(0, 10)}).`,
    );
  }

  const { fecha, hora } = bogota(d.ahora);
  const validado = bogota(d.validadoAt ?? d.ahora);
  const sender = partyTaxSchemeDe(factura, 'AccountingSupplierParty') || partyTaxSchemeDeDatos(d.emisor);
  const receiver = partyTaxSchemeDe(factura, 'AccountingCustomerParty') || partyTaxSchemeDeDatos(d.adquiriente);
  const numero = escapar(d.fullNumber);

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<AttachedDocument xmlns="${NS_ATTACHED}" xmlns:cac="${NS_CAC}" xmlns:cbc="${NS_CBC}"` +
    ` xmlns:ext="${NS_EXT}" xmlns:ds="${NS_DS}">` +
    `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>` +
    `<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>` +
    `<cbc:CustomizationID>Documentos adjuntos</cbc:CustomizationID>` +
    `<cbc:ProfileID>Factura Electrónica de Venta</cbc:ProfileID>` +
    `<cbc:ProfileExecutionID>${escapar(d.tipoAmbiente)}</cbc:ProfileExecutionID>` +
    `<cbc:ID>${numero}</cbc:ID>` +
    `<cbc:IssueDate>${fecha}</cbc:IssueDate>` +
    `<cbc:IssueTime>${hora}</cbc:IssueTime>` +
    `<cbc:DocumentType>Contenedor de Factura Electrónica</cbc:DocumentType>` +
    `<cbc:ParentDocumentID>${numero}</cbc:ParentDocumentID>` +
    `<cac:SenderParty>${sender}</cac:SenderParty>` +
    `<cac:ReceiverParty>${receiver}</cac:ReceiverParty>` +
    `<cac:Attachment><cac:ExternalReference>` +
    `<cbc:MimeCode>text/xml</cbc:MimeCode><cbc:EncodingCode>UTF-8</cbc:EncodingCode>` +
    `<cbc:Description>${cdata(factura)}</cbc:Description>` +
    `</cac:ExternalReference></cac:Attachment>` +
    `<cac:ParentDocumentLineReference><cbc:LineID>1</cbc:LineID><cac:DocumentReference>` +
    `<cbc:ID>${numero}</cbc:ID>` +
    `<cbc:UUID schemeName="CUFE-SHA384">${escapar(cufe)}</cbc:UUID>` +
    `<cbc:IssueDate>${escapar(d.issueDate)}</cbc:IssueDate>` +
    `<cbc:DocumentType>ApplicationResponse</cbc:DocumentType>` +
    `<cac:Attachment><cac:ExternalReference>` +
    `<cbc:MimeCode>text/xml</cbc:MimeCode><cbc:EncodingCode>UTF-8</cbc:EncodingCode>` +
    `<cbc:Description>${cdata(ar)}</cbc:Description>` +
    `</cac:ExternalReference></cac:Attachment>` +
    `<cac:ResultOfVerification>` +
    `<cbc:ValidatorID>${VALIDADOR_DIAN}</cbc:ValidatorID>` +
    `<cbc:ValidationResultCode>${CODIGO_DOCUMENTO_VALIDADO}</cbc:ValidationResultCode>` +
    `<cbc:ValidationDate>${validado.fecha}</cbc:ValidationDate>` +
    `<cbc:ValidationTime>${validado.hora}</cbc:ValidationTime>` +
    `</cac:ResultOfVerification>` +
    `</cac:DocumentReference></cac:ParentDocumentLineReference>` +
    `</AttachedDocument>`
  );
}

/**
 * La ApplicationResponse guardada en `respuestaDian.applicationResponse`
 * (base64 del `XmlBase64Bytes` de la DIAN), o `null` si no está.
 *
 * El adaptador (`mapeo-respuesta.ts`) la guarda solo en una aceptación cuyo XML
 * ya validó (ApplicationResponse del mismo CUFE) y `TransmisionDianService.limpiar`
 * la conserva; si falta, la entrega queda en el PDF (`SIN_APPLICATION_RESPONSE`).
 */
export function applicationResponseDe(respuestaDian: unknown): string | null {
  const b64 = (respuestaDian as { applicationResponse?: unknown } | null | undefined)?.applicationResponse;
  if (typeof b64 !== 'string' || !b64.trim()) return null;
  const xml = Buffer.from(b64, 'base64').toString('utf8');
  return /<(?:\w+:)?ApplicationResponse[\s>]/.test(xml) ? xml : null;
}
