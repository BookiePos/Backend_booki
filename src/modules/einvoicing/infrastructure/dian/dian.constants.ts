import type { TipoAmbiente } from '../../domain/emisor-fiscal';

/**
 * Constantes del servicio web de la DIAN (WcfDianCustomerServices, SOAP 1.2 con
 * WS-Security). Lo que no está confirmado contra habilitación queda aquí, aislado,
 * para corregirlo en un solo sitio (ver «Confirmar en habilitación» en el PR).
 */

/** URL del servicio por ambiente. Sin valor por defecto: el ambiente lo decide el emisor. */
export const URL_DIAN_POR_AMBIENTE: Readonly<Record<TipoAmbiente, string>> = {
  '1': 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc',
  '2': 'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc',
};

export const OPERACIONES_DIAN = [
  'SendBillSync',
  'SendTestSetAsync',
  'GetStatusZip',
  'GetStatus',
  'GetNumberingRange',
] as const;
export type OperacionDian = (typeof OPERACIONES_DIAN)[number];

/** `wsa:Action` de cada operación. */
export function accionDian(op: OperacionDian): string {
  return `http://wcf.dian.colombia/IWcfDianCustomerServices/${op}`;
}

export const NS_SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';
export const NS_WCF = 'http://wcf.dian.colombia';
export const NS_WSA = 'http://www.w3.org/2005/08/addressing';
export const NS_WSSE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
export const NS_WSU =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
export const NS_DS_WSS = 'http://www.w3.org/2000/09/xmldsig#';

export const VALUE_TYPE_X509 =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
export const ENCODING_BASE64 =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

export const ALG_EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const ALG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const ALG_SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

/**
 * Partes del encabezado que se firman: `To`, `Action` y `Timestamp` (el sello
 * firmado impide reusar un mensaje capturado fuera de su ventana). La práctica
 * conocida de las librerías que hablan con la DIAN firma solo `wsa:To`; si WCF
 * rechaza alguna referencia en habilitación, se ajusta aquí. POR CONFIRMAR.
 */
export const PARTES_FIRMADAS = ['To', 'Action', 'Timestamp'] as const;
export type ParteFirmada = (typeof PARTES_FIRMADAS)[number];

/** Vida del `wsu:Timestamp` (Created → Expires). */
export const VIDA_TIMESTAMP_MS = 60_000;

/** Presupuesto de tiempo por llamada si no se configura otro. */
export const PRESUPUESTO_POR_DEFECTO_MS = 8_000;

/** Tope de la respuesta que se acepta leer (una respuesta normal pesa unos KB). */
export const MAX_BYTES_RESPUESTA = 5 * 1024 * 1024;

/**
 * Regla 90 de la DIAN: el documento ya fue procesado (reenvío). SendBillSync
 * responde IsValid=false aunque el original pueda estar aceptado.
 */
export const PATRON_YA_PROCESADO = /regla:?\s*90\b|procesado anteriormente/i;

/** Set de pruebas o lote que la DIAN aún valida. POR CONFIRMAR el texto exacto. */
export const PATRON_EN_PROCESO = /en proceso de validaci[oó]n|en proceso/i;

/** StatusCode con el que la DIAN marca «validación con errores». */
export const STATUS_CON_ERRORES = '99';

/**
 * StatusCode de GetStatus cuando la DIAN no encuentra el documento: no es un
 * rechazo, es «no recibido». POR CONFIRMAR en habilitación.
 */
export const STATUS_NO_ENCONTRADO = ['66'] as const;

/** Texto de GetStatus para «documento no encontrado / no existe». POR CONFIRMAR. */
export const PATRON_NO_ENCONTRADO = /no (fue )?encontrad[oa]|no existe|not found/i;

/** OperationCode de GetNumberingRange cuando la consulta salió bien. */
export const OPERACION_RANGOS_OK = '100';
