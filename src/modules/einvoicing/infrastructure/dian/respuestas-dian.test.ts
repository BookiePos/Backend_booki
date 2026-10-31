/**
 * Respuestas de ejemplo del WCF de la DIAN para los specs (no es un spec). Copian
 * la forma real: DataContract con prefijos `b:`/`c:`, `i:nil`, sobre SOAP 1.2.
 */

const SOBRE_INICIO =
  '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" ' +
  'xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
  '<s:Header><a:Action s:mustUnderstand="1">http://wcf.dian.colombia/IWcfDianCustomerServices/RespuestaX</a:Action></s:Header><s:Body>';
const SOBRE_FIN = '</s:Body></s:Envelope>';

export function sobre(cuerpo: string): string {
  return `${SOBRE_INICIO}${cuerpo}${SOBRE_FIN}`;
}

export interface DatosDianResponse {
  isValid?: 'true' | 'false';
  statusCode?: string;
  descripcion?: string;
  errores?: string[];
  cufe?: string;
}

export function dianResponseInterno(d: DatosDianResponse, etiqueta = 'b'): string {
  const errores = (d.errores ?? []).map((e) => `<c:string>${e}</c:string>`).join('');
  return (
    `<${etiqueta}:ErrorMessage xmlns:c="http://schemas.microsoft.com/2003/10/Serialization/Arrays">${errores}</${etiqueta}:ErrorMessage>` +
    (d.isValid ? `<${etiqueta}:IsValid>${d.isValid}</${etiqueta}:IsValid>` : '') +
    `<${etiqueta}:StatusCode>${d.statusCode ?? '00'}</${etiqueta}:StatusCode>` +
    `<${etiqueta}:StatusDescription>${d.descripcion ?? ''}</${etiqueta}:StatusDescription>` +
    `<${etiqueta}:StatusMessage>La Factura electrónica SETP990000001, ha sido autorizada.</${etiqueta}:StatusMessage>` +
    `<${etiqueta}:XmlBase64Bytes>PD94bWwgdmVyc2lvbj0iMS4wIj8+</${etiqueta}:XmlBase64Bytes>` +
    `<${etiqueta}:XmlBytes i:nil="true"/>` +
    `<${etiqueta}:XmlDocumentKey>${d.cufe ?? 'cufe-de-prueba-123'}</${etiqueta}:XmlDocumentKey>` +
    `<${etiqueta}:XmlFileName>fv09001234560002600000001</${etiqueta}:XmlFileName>`
  );
}

/** SendBillSync o GetStatus (misma forma DianResponse). */
export function respuestaDocumento(op: 'SendBillSync' | 'GetStatus', d: DatosDianResponse): string {
  return sobre(
    `<${op}Response xmlns="http://wcf.dian.colombia"><${op}Result xmlns:b="http://schemas.datacontract.org/2004/07/DianResponse" ` +
      `xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${dianResponseInterno(d)}</${op}Result></${op}Response>`,
  );
}

export function respuestaStatusZip(items: DatosDianResponse[]): string {
  const cuerpo = items.map((d) => `<b:DianResponse>${dianResponseInterno(d)}</b:DianResponse>`).join('');
  return sobre(
    '<GetStatusZipResponse xmlns="http://wcf.dian.colombia"><GetStatusZipResult xmlns:b="http://schemas.datacontract.org/2004/07/DianResponse" ' +
      `xmlns:i="http://www.w3.org/2001/XMLSchema-instance">${cuerpo}</GetStatusZipResult></GetStatusZipResponse>`,
  );
}

export function respuestaTestSet(zipKey?: string, errores: string[] = []): string {
  const lista = errores
    .map(
      (e) =>
        `<c:XmlParamsResponseTrackId><c:DocumentKey i:nil="true"/><c:ProcessedMessage>${e}</c:ProcessedMessage>` +
        '<c:SenderCode>900123456</c:SenderCode><c:Success>false</c:Success><c:XmlFileName>fv.xml</c:XmlFileName></c:XmlParamsResponseTrackId>',
    )
    .join('');
  return sobre(
    '<SendTestSetAsyncResponse xmlns="http://wcf.dian.colombia"><SendTestSetAsyncResult xmlns:b="http://schemas.datacontract.org/2004/07/UploadDocumentResponse" ' +
      'xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
      `<b:ErrorMessageList xmlns:c="http://schemas.datacontract.org/2004/07/XmlParamsResponseTrackId">${lista}</b:ErrorMessageList>` +
      (zipKey ? `<b:ZipKey>${zipKey}</b:ZipKey>` : '<b:ZipKey i:nil="true"/>') +
      '</SendTestSetAsyncResult></SendTestSetAsyncResponse>',
  );
}

export const CLAVE_TECNICA_PRUEBA = 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c';

export function respuestaRangos(codigo = '100', rangos = 1): string {
  const items = Array.from(
    { length: rangos },
    (_, i) =>
      '<c:NumberRangeResponse>' +
      `<c:ResolutionNumber>1876000000${i}</c:ResolutionNumber><c:ResolutionDate>2019-01-19</c:ResolutionDate>` +
      `<c:Prefix>SETP</c:Prefix><c:FromNumber>990000000</c:FromNumber><c:ToNumber>995000000</c:ToNumber>` +
      '<c:ValidDateFrom>2019-01-19</c:ValidDateFrom><c:ValidDateTo>2030-01-19</c:ValidDateTo>' +
      `<c:TechnicalKey>${CLAVE_TECNICA_PRUEBA}</c:TechnicalKey></c:NumberRangeResponse>`,
  ).join('');
  return sobre(
    '<GetNumberingRangeResponse xmlns="http://wcf.dian.colombia"><GetNumberingRangeResult xmlns:b="http://schemas.datacontract.org/2004/07/NumberRangeResponseList" ' +
      'xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
      `<b:OperationCode>${codigo}</b:OperationCode><b:OperationDescription>${codigo === '100' ? 'Acción completada OK.' : 'No se encontró registro de software.'}</b:OperationDescription>` +
      `<b:ResponseList xmlns:c="http://schemas.datacontract.org/2004/07/NumberRangeResponse">${items}</b:ResponseList>` +
      '</GetNumberingRangeResult></GetNumberingRangeResponse>',
  );
}

export function faultSoap(codigo: 'Sender' | 'Receiver', subcodigo: string, razon: string): string {
  return sobre(
    `<s:Fault><s:Code><s:Value>s:${codigo}</s:Value><s:Subcode><s:Value xmlns:a="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">a:${subcodigo}</s:Value></s:Subcode></s:Code>` +
      `<s:Reason><s:Text xml:lang="es-CO">${razon}</s:Text></s:Reason></s:Fault>`,
  );
}
