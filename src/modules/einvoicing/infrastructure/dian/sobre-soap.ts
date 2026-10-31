import { randomUUID } from 'crypto';
import { SignedXml } from 'xml-crypto';
import {
  accionDian,
  ALG_EXC_C14N,
  ALG_RSA_SHA256,
  ALG_SHA256,
  ENCODING_BASE64,
  NS_SOAP12,
  NS_WCF,
  NS_WSA,
  NS_WSSE,
  NS_WSU,
  PARTES_FIRMADAS,
  VALUE_TYPE_X509,
  VIDA_TIMESTAMP_MS,
  type OperacionDian,
  type ParteFirmada,
} from './dian.constants';

/**
 * Sobre SOAP 1.2 con WS-Security para el WCF de la DIAN:
 *
 *  - `wsse:BinarySecurityToken` con el X.509 del emisor (DER en base64).
 *  - `wsu:Timestamp` con Created/Expires.
 *  - `wsa:Action` y `wsa:To` con `wsu:Id`, firmados (ver `PARTES_FIRMADAS`).
 *  - `ds:Signature` RSA-SHA256, digest SHA-256 y exc-c14n, con `KeyInfo` que
 *    apunta al token por `wsse:SecurityTokenReference`.
 *
 * La llave privada solo entra a xml-crypto; nunca se copia al sobre ni a un error.
 */

/** Lo que el sobre necesita del certificado (sale de `abrirP12`). */
export interface CredencialSoap {
  llavePem: string;
  /** DER del certificado del firmante en base64, sin saltos. */
  certificadoB64: string;
}

export interface OpcionesSobre {
  ahora?: Date;
  /** Semilla para los `wsu:Id`; por defecto, un UUID. */
  uuid?: string;
  /** Partes del encabezado a firmar; por defecto `PARTES_FIRMADAS`. */
  partes?: readonly ParteFirmada[];
}

/** Parámetros del cuerpo, en el orden del contrato WSDL. */
export type ParametrosOperacion = ReadonlyArray<readonly [nombre: string, valor: string]>;

export function escaparXml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Cuerpo `<wcf:Operacion>` con sus parámetros. */
export function cuerpoOperacion(op: OperacionDian, params: ParametrosOperacion): string {
  const hijos = params
    .map(([n, v]) => {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(n)) throw new Error('Nombre de parámetro inválido');
      return `<wcf:${n}>${escaparXml(v)}</wcf:${n}>`;
    })
    .join('');
  return `<wcf:${op}>${hijos}</wcf:${op}>`;
}

/** Arma y firma el sobre completo de una operación. */
export function sobreFirmado(
  op: OperacionDian,
  url: string,
  params: ParametrosOperacion,
  cred: CredencialSoap,
  opciones: OpcionesSobre = {},
): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(cred.certificadoB64)) {
    throw new Error('Certificado del emisor inválido para WS-Security');
  }
  const ahora = opciones.ahora ?? new Date();
  const semilla = opciones.uuid ?? randomUUID();
  const ids = {
    token: `X509-${semilla}`,
    timestamp: `TS-${semilla}`,
    to: `id-to-${semilla}`,
    action: `id-action-${semilla}`,
    str: `STR-${semilla}`,
  };
  const creado = ahora.toISOString();
  const vence = new Date(ahora.getTime() + VIDA_TIMESTAMP_MS).toISOString();

  const xml =
    `<soap:Envelope xmlns:soap="${NS_SOAP12}" xmlns:wcf="${NS_WCF}">` +
    `<soap:Header xmlns:wsa="${NS_WSA}">` +
    `<wsse:Security soap:mustUnderstand="true" xmlns:wsse="${NS_WSSE}" xmlns:wsu="${NS_WSU}">` +
    `<wsu:Timestamp wsu:Id="${ids.timestamp}"><wsu:Created>${creado}</wsu:Created><wsu:Expires>${vence}</wsu:Expires></wsu:Timestamp>` +
    `<wsse:BinarySecurityToken EncodingType="${ENCODING_BASE64}" ValueType="${VALUE_TYPE_X509}" wsu:Id="${ids.token}">${cred.certificadoB64}</wsse:BinarySecurityToken>` +
    `</wsse:Security>` +
    `<wsa:Action wsu:Id="${ids.action}" xmlns:wsu="${NS_WSU}">${accionDian(op)}</wsa:Action>` +
    `<wsa:To wsu:Id="${ids.to}" xmlns:wsu="${NS_WSU}">${escaparXml(url)}</wsa:To>` +
    `</soap:Header>` +
    `<soap:Body>${cuerpoOperacion(op, params)}</soap:Body>` +
    `</soap:Envelope>`;

  const firma = new SignedXml({
    privateKey: cred.llavePem,
    signatureAlgorithm: ALG_RSA_SHA256,
    canonicalizationAlgorithm: ALG_EXC_C14N,
    idMode: 'wssecurity',
    getKeyInfoContent: () =>
      `<wsse:SecurityTokenReference wsu:Id="${ids.str}">` +
      `<wsse:Reference URI="#${ids.token}" ValueType="${VALUE_TYPE_X509}"/>` +
      `</wsse:SecurityTokenReference>`,
  });
  for (const parte of opciones.partes ?? PARTES_FIRMADAS) {
    const ns = parte === 'Timestamp' ? NS_WSU : NS_WSA;
    firma.addReference({
      xpath: `//*[local-name()='${parte}' and namespace-uri()='${ns}']`,
      transforms: [ALG_EXC_C14N],
      digestAlgorithm: ALG_SHA256,
    });
  }
  firma.computeSignature(xml, {
    prefix: 'ds',
    existingPrefixes: { wsse: NS_WSSE, wsu: NS_WSU },
    location: {
      reference: `//*[local-name()='Security' and namespace-uri()='${NS_WSSE}']`,
      action: 'append',
    },
  });
  return firma.getSignedXml();
}

/** Content-Type de SOAP 1.2 con la acción (WCF la exige también aquí). */
export function contentTypeSoap(op: OperacionDian): string {
  return `application/soap+xml;charset=utf-8;action="${accionDian(op)}"`;
}
