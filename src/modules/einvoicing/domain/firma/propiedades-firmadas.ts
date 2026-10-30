import {
  ALG_RESUMEN_SHA256,
  NS_XADES,
  NS_XADES141,
  POLITICA_FIRMA_DIAN,
  ROL_FIRMANTE_EMISOR,
  ZONA_HORARIA_COLOMBIA,
  type RolFirmante,
} from './firma.constants';

/**
 * Piezas puras de la firma XAdES-EPES: ids de los nodos, `SigningTime` en hora
 * colombiana, nombre del emisor en texto y el XML de `xades:QualifyingProperties`.
 * Nada aquí toca llaves ni certificados: recibe los resúmenes ya calculados.
 */

/** Ids de los nodos de una firma (anexo de nómina v1.0 §7.9; política v2 §13). */
export interface IdsFirma {
  firma: string;
  referenciaDocumento: string;
  keyInfo: string;
  signedProperties: string;
  signatureValue: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idsFirma(uuid: string): IdsFirma {
  if (!UUID.test(uuid)) throw new Error('El id de la firma debe ser un UUID');
  const base = `xmldsig-${uuid.toLowerCase()}`;
  return {
    firma: base,
    referenciaDocumento: `${base}-ref0`,
    keyInfo: `${base}-keyinfo`,
    signedProperties: `${base}-signedprops`,
    signatureValue: `${base}-sigvalue`,
  };
}

const dos = (n: number): string => String(n).padStart(2, '0');

/**
 * `xsd:dateTime` en hora legal colombiana, p. ej. `2026-10-30T09:15:00-05:00`.
 * Se calcula desde el instante UTC para no depender de la zona del servidor
 * (Vercel corre en UTC).
 */
export function signingTimeColombia(instante: Date): string {
  const t = instante.getTime();
  if (!Number.isFinite(t)) throw new Error('Fecha de firma inválida');
  const local = new Date(t - 5 * 60 * 60 * 1000);
  return (
    `${local.getUTCFullYear()}-${dos(local.getUTCMonth() + 1)}-${dos(local.getUTCDate())}` +
    `T${dos(local.getUTCHours())}:${dos(local.getUTCMinutes())}:${dos(local.getUTCSeconds())}` +
    ZONA_HORARIA_COLOMBIA
  );
}

/** Escapa texto y valores de atributo para XML. */
export function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Un atributo de un nombre X.500, en el orden en que viene en el certificado. */
export interface AtributoNombre {
  /** Nombre corto (CN, O, OU, C, L, ST, E…) o, si no lo tiene, el OID. */
  tipo: string;
  valor: string;
}

/**
 * Nombre distinguido en texto según RFC 4514: del atributo más específico al más
 * general (orden inverso al del certificado), separados por coma, con los
 * caracteres especiales escapados. Es la forma que usan .NET y OpenSSL; la DIAN
 * no fija una (anexo v1.9 DC31 solo dice «Subject del certificado»).
 */
export function nombreRfc4514(atributos: readonly AtributoNombre[]): string {
  return [...atributos]
    .reverse()
    .map(({ tipo, valor }) => `${tipo}=${escaparValorRfc4514(valor)}`)
    .join(',');
}

function escaparValorRfc4514(valor: string): string {
  let v = valor.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`);
  if (v.startsWith(' ') || v.startsWith('#')) v = `\\${v}`;
  if (v.endsWith(' ') && !v.endsWith('\\ ')) v = `${v.slice(0, -1)}\\ `;
  return v;
}

/** Un certificado de la cadena dentro de `xades:SigningCertificate`. */
export interface CertificadoFirmante {
  /** SHA-256 del DER del certificado, en base64. */
  resumenB64: string;
  /** Nombre del EMISOR del certificado (RFC 4514). */
  emisor: string;
  /** Número de serie en decimal. */
  serialDecimal: string;
}

export interface DatosPropiedadesFirmadas {
  ids: IdsFirma;
  signingTime: string;
  /** Cadena del firmante primero, luego las intermedias y por último la raíz. */
  cadena: readonly CertificadoFirmante[];
  rol?: RolFirmante;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL = /^\d+$/;

/**
 * `<xades:QualifyingProperties>` completo (anexo v1.9 DC21–DC56), sin espacios
 * entre etiquetas (política v2 §16: nada de pretty-print). El prefijo `ds:` lo
 * resuelve el `ds:Signature` que lo envuelve.
 */
export function armarQualifyingProperties(datos: DatosPropiedadesFirmadas): string {
  if (datos.cadena.length === 0) throw new Error('La cadena de certificación está vacía');
  for (const c of datos.cadena) {
    if (!B64.test(c.resumenB64)) throw new Error('Resumen de certificado inválido');
    if (!DECIMAL.test(c.serialDecimal)) throw new Error('Serial de certificado inválido');
  }
  const rol = datos.rol ?? ROL_FIRMANTE_EMISOR;
  const certs = datos.cadena
    .map(
      (c) =>
        '<xades:Cert>' +
        '<xades:CertDigest>' +
        `<ds:DigestMethod Algorithm="${ALG_RESUMEN_SHA256}"/>` +
        `<ds:DigestValue>${c.resumenB64}</ds:DigestValue>` +
        '</xades:CertDigest>' +
        '<xades:IssuerSerial>' +
        `<ds:X509IssuerName>${escaparXml(c.emisor)}</ds:X509IssuerName>` +
        `<ds:X509SerialNumber>${c.serialDecimal}</ds:X509SerialNumber>` +
        '</xades:IssuerSerial>' +
        '</xades:Cert>',
    )
    .join('');
  return (
    `<xades:QualifyingProperties xmlns:xades="${NS_XADES}" xmlns:xades141="${NS_XADES141}" Target="#${datos.ids.firma}">` +
    `<xades:SignedProperties Id="${datos.ids.signedProperties}">` +
    '<xades:SignedSignatureProperties>' +
    `<xades:SigningTime>${escaparXml(datos.signingTime)}</xades:SigningTime>` +
    `<xades:SigningCertificate>${certs}</xades:SigningCertificate>` +
    '<xades:SignaturePolicyIdentifier>' +
    '<xades:SignaturePolicyId>' +
    '<xades:SigPolicyId>' +
    `<xades:Identifier>${POLITICA_FIRMA_DIAN.identificador}</xades:Identifier>` +
    '</xades:SigPolicyId>' +
    '<xades:SigPolicyHash>' +
    `<ds:DigestMethod Algorithm="${POLITICA_FIRMA_DIAN.algoritmoResumen}"/>` +
    `<ds:DigestValue>${POLITICA_FIRMA_DIAN.resumen}</ds:DigestValue>` +
    '</xades:SigPolicyHash>' +
    '</xades:SignaturePolicyId>' +
    '</xades:SignaturePolicyIdentifier>' +
    '<xades:SignerRole>' +
    '<xades:ClaimedRoles>' +
    `<xades:ClaimedRole>${escaparXml(rol)}</xades:ClaimedRole>` +
    '</xades:ClaimedRoles>' +
    '</xades:SignerRole>' +
    '</xades:SignedSignatureProperties>' +
    '</xades:SignedProperties>' +
    '</xades:QualifyingProperties>'
  );
}

/**
 * Qué `ext:UBLExtension` (base 1) lleva la firma. Factura, notas, POS y
 * ApplicationResponse llevan DianExtensions en la primera y la firma en la
 * segunda (política v2 §8: `UBLExtension[2]`). La nómina (anexo de nómina NIE001)
 * trae una sola extensión y la firma va en ella.
 */
export function extensionDeFirma(totalExtensiones: number): number {
  if (!Number.isInteger(totalExtensiones) || totalExtensiones < 1) {
    throw new Error('El documento no tiene ext:UBLExtension para la firma');
  }
  return totalExtensiones === 1 ? 1 : 2;
}
