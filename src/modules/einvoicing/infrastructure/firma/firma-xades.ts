import { createHash, randomUUID, X509Certificate } from 'crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import {
  ALG_C14N,
  ALG_ENVELOPED,
  ALG_FIRMA_RSA_SHA256,
  ALG_RESUMEN_SHA256,
  NS_DS,
  NS_EXT,
  NS_XADES,
  POLITICA_FIRMA_DIAN,
  TIPO_REF_SIGNED_PROPERTIES,
  type RolFirmante,
} from '../../domain/firma/firma.constants';
import {
  armarQualifyingProperties,
  extensionDeFirma,
  idsFirma,
  signingTimeColombia,
} from '../../domain/firma/propiedades-firmadas';
import { abrirP12, ErrorFirma } from './material-p12';

/**
 * Firma XAdES-EPES enveloped de la DIAN (anexo FEV v1.9 §6.10 y política de firma
 * v2). Un único perfil para factura, notas, POS, nómina, ApplicationResponse y
 * AttachedDocument: solo cambia el elemento raíz, y el documento debe traer vacía
 * la `ext:ExtensionContent` donde va la firma (la segunda extensión, o la única).
 *
 * - `SignedInfo` con Canonical XML 1.0 inclusivo y RSA-SHA256.
 * - Tres referencias SHA-256: el documento (`URI=""` + enveloped), `KeyInfo` y
 *   `SignedProperties`.
 * - `SigningCertificate` con la cadena que traiga el .p12 (firmante → raíz).
 */

export interface CertificadoP12 {
  p12: Buffer;
  password: string;
}

export interface OpcionesFirma {
  /** Instante de la firma; por defecto, ahora. */
  ahora?: Date;
  /** UUID para los ids `xmldsig-…`; por defecto, uno aleatorio. */
  uuid?: string;
  /** Por defecto `supplier`: firma el emisor con su propio certificado. */
  rol?: RolFirmante;
}

const ruta = (nombre: string): string => `*[local-name()='${nombre}']`;

function parsear(xml: string): Document {
  let error = false;
  const doc = new DOMParser({
    errorHandler: { warning: () => undefined, error: () => (error = true), fatalError: () => (error = true) },
  }).parseFromString(xml, 'text/xml') as unknown as Document;
  if (error || !doc?.documentElement) {
    throw new ErrorFirma('xml_invalido', 'El XML a firmar no está bien formado');
  }
  return doc;
}

function hijos(el: Element, ns: string, nombre: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === nombre) {
      out.push(n as Element);
    }
  }
  return out;
}

function tieneElementos(el: Element): boolean {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) return true;
  return false;
}

/** La `ext:ExtensionContent` que lleva la firma y su posición (base 1). */
function ranura(doc: Document): { contenido: Element; posicion: number } {
  const [extensiones] = hijos(doc.documentElement, NS_EXT, 'UBLExtensions');
  const lista = extensiones ? hijos(extensiones, NS_EXT, 'UBLExtension') : [];
  if (lista.length === 0) {
    throw new ErrorFirma('sin_ranura', 'El documento no tiene ext:UBLExtensions/ext:UBLExtension');
  }
  const posicion = extensionDeFirma(lista.length);
  const [contenido] = hijos(lista[posicion - 1]!, NS_EXT, 'ExtensionContent');
  if (!contenido) {
    throw new ErrorFirma('sin_ranura', `La ext:UBLExtension ${posicion} no tiene ext:ExtensionContent`);
  }
  return { contenido, posicion };
}

export function firmarXml(xml: string, cert: CertificadoP12, opciones: OpcionesFirma = {}): string {
  const doc = parsear(xml);
  if (doc.getElementsByTagNameNS(NS_DS, 'Signature').length > 0) {
    throw new ErrorFirma('ya_firmado', 'El documento ya trae una ds:Signature');
  }
  const { contenido, posicion } = ranura(doc);
  if (tieneElementos(contenido)) {
    throw new ErrorFirma('sin_ranura', `La ext:ExtensionContent ${posicion} debe estar vacía para la firma`);
  }

  const material = abrirP12(cert.p12, cert.password);
  const ids = idsFirma(opciones.uuid ?? randomUUID());
  const propiedades = armarQualifyingProperties({
    ids,
    signingTime: signingTimeColombia(opciones.ahora ?? new Date()),
    cadena: material.cadena,
    rol: opciones.rol,
  });

  const firma = new SignedXml({
    privateKey: material.llavePem,
    publicCert: material.certificadoPem,
    signatureAlgorithm: ALG_FIRMA_RSA_SHA256,
    canonicalizationAlgorithm: ALG_C14N,
    keyInfoAttributes: { Id: ids.keyInfo },
    getKeyInfoContent: ({ prefix } = {}) => {
      const p = prefix ? `${prefix}:` : '';
      return `<${p}X509Data><${p}X509Certificate>${material.certificadoB64}</${p}X509Certificate></${p}X509Data>`;
    },
    objects: [{ content: propiedades }],
  });
  firma.addReference({
    xpath: '/*',
    isEmptyUri: true,
    id: ids.referenciaDocumento,
    transforms: [ALG_ENVELOPED],
    digestAlgorithm: ALG_RESUMEN_SHA256,
  });
  // El ejemplo del anexo de nómina §7.9 no trae Transforms en estas dos; xml-crypto
  // exige al menos una, así que se declara C14N 1.0, que es el mismo canon que la
  // referencia sin transformadas recibiría por defecto (XMLDSig §4.4.3.2).
  firma.addReference({
    xpath: `//${ruta('KeyInfo')}[@Id='${ids.keyInfo}']`,
    transforms: [ALG_C14N],
    digestAlgorithm: ALG_RESUMEN_SHA256,
  });
  firma.addReference({
    xpath: `//${ruta('SignedProperties')}[@Id='${ids.signedProperties}']`,
    type: TIPO_REF_SIGNED_PROPERTIES,
    transforms: [ALG_C14N],
    digestAlgorithm: ALG_RESUMEN_SHA256,
  });

  const raiz = doc.documentElement;
  const yaDeclarados: Record<string, string> = {};
  if (raiz.lookupNamespaceURI('ds') === NS_DS) yaDeclarados.ds = NS_DS;

  firma.computeSignature(xml, {
    prefix: 'ds',
    attrs: { Id: ids.firma },
    existingPrefixes: yaDeclarados,
    location: {
      reference: `/*/${ruta('UBLExtensions')}/${ruta('UBLExtension')}[${posicion}]/${ruta('ExtensionContent')}`,
      action: 'append',
    },
  });
  return conIdEnSignatureValue(firma.getSignedXml(), ids.firma, ids.signatureValue);
}

/** `SignatureValue` queda fuera de `SignedInfo`: ponerle el Id no altera la firma. */
function conIdEnSignatureValue(xml: string, idFirma: string, idValor: string): string {
  const doc = parsear(xml);
  const firma = Array.from(doc.getElementsByTagNameNS(NS_DS, 'Signature')).find(
    (s) => s.getAttribute('Id') === idFirma,
  );
  const [valor] = firma ? hijos(firma, NS_DS, 'SignatureValue') : [];
  if (!valor) return xml;
  valor.setAttribute('Id', idValor);
  return new XMLSerializer().serializeToString(doc as unknown as Node);
}

export interface ResultadoVerificacion {
  valida: boolean;
  motivo?: string;
}

const ALG_HASH: Record<string, string> = {
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384': 'sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512',
};

const invalida = (motivo: string): ResultadoVerificacion => ({ valida: false, motivo });

/**
 * Verifica la integridad de una firma XAdES-EPES de la DIAN con el certificado
 * que trae su propio `KeyInfo`. NO valida la confianza del certificado (ECD,
 * vigencia, revocación): eso es de la carga del .p12 y de la DIAN.
 */
export function verificarFirma(xmlFirmado: string): ResultadoVerificacion {
  let doc: Document;
  try {
    doc = parsear(xmlFirmado);
  } catch {
    return invalida('El XML no está bien formado');
  }
  const firmas = Array.from(doc.getElementsByTagNameNS(NS_DS, 'Signature'));
  if (firmas.length !== 1) return invalida(`Se esperaba una ds:Signature y hay ${firmas.length}`);
  const firmaNodo = firmas[0]!;

  try {
    if (firmaNodo.parentNode !== ranura(doc).contenido) {
      return invalida('La firma no está en la ext:UBLExtension que le corresponde');
    }
  } catch {
    return invalida('El documento no tiene la ext:UBLExtension de la firma');
  }

  const [signedInfo] = hijos(firmaNodo, NS_DS, 'SignedInfo');
  const [keyInfo] = hijos(firmaNodo, NS_DS, 'KeyInfo');
  const [objeto] = hijos(firmaNodo, NS_DS, 'Object');
  if (!signedInfo || !keyInfo || !objeto) return invalida('Faltan SignedInfo, KeyInfo u Object');

  const [c14n] = hijos(signedInfo, NS_DS, 'CanonicalizationMethod');
  const [metodo] = hijos(signedInfo, NS_DS, 'SignatureMethod');
  if (c14n?.getAttribute('Algorithm') !== ALG_C14N) return invalida('Canon de SignedInfo distinto de C14N 1.0');
  if (metodo?.getAttribute('Algorithm') !== ALG_FIRMA_RSA_SHA256) return invalida('Algoritmo de firma distinto de RSA-SHA256');

  const signedProps = Array.from(objeto.getElementsByTagNameNS(NS_XADES, 'SignedProperties'));
  if (signedProps.length !== 1) return invalida('Se esperaba un xades:SignedProperties');
  const idKeyInfo = keyInfo.getAttribute('Id');
  const idProps = signedProps[0]!.getAttribute('Id');
  if (!idKeyInfo || !idProps) return invalida('KeyInfo y SignedProperties deben tener Id');

  const refs = hijos(signedInfo, NS_DS, 'Reference');
  if (refs.length !== 3) return invalida(`Se esperaban 3 referencias y hay ${refs.length}`);
  const refDoc = refs.find((r) => r.getAttribute('URI') === '');
  const refKey = refs.find((r) => r.getAttribute('URI') === `#${idKeyInfo}`);
  const refProps = refs.find((r) => r.getAttribute('URI') === `#${idProps}`);
  if (!refDoc || !refKey || !refProps) {
    return invalida('Las referencias deben cubrir el documento, KeyInfo y SignedProperties');
  }
  const transformadas = Array.from(refDoc.getElementsByTagNameNS(NS_DS, 'Transform')).map((t) =>
    t.getAttribute('Algorithm'),
  );
  if (!transformadas.includes(ALG_ENVELOPED)) return invalida('La referencia al documento no es enveloped');
  if (refProps.getAttribute('Type') !== TIPO_REF_SIGNED_PROPERTIES) {
    return invalida('La referencia a SignedProperties no declara su Type');
  }

  const [x509Data] = hijos(keyInfo, NS_DS, 'X509Data');
  const [x509] = x509Data ? hijos(x509Data, NS_DS, 'X509Certificate') : [];
  const certB64 = (x509?.textContent ?? '').replace(/\s+/g, '');
  if (!certB64) return invalida('KeyInfo no trae ds:X509Certificate');
  let certificado: X509Certificate;
  try {
    certificado = new X509Certificate(Buffer.from(certB64, 'base64'));
  } catch {
    return invalida('El certificado de KeyInfo no es legible');
  }

  try {
    const verificador = new SignedXml({ publicCert: certificado.toString() });
    verificador.loadSignature(firmaNodo as unknown as Node);
    if (!verificador.checkSignature(xmlFirmado)) {
      return invalida('La firma o alguna de sus referencias no coincide con el contenido');
    }
  } catch {
    return invalida('La firma o alguna de sus referencias no coincide con el contenido');
  }

  const motivoCert = verificarSigningCertificate(signedProps[0]!, certificado);
  if (motivoCert) return invalida(motivoCert);
  const motivoPolitica = verificarPolitica(signedProps[0]!);
  if (motivoPolitica) return invalida(motivoPolitica);
  return { valida: true };
}

function texto(el: Element | undefined, ns: string, nombre: string): string {
  const [n] = el ? Array.from(el.getElementsByTagNameNS(ns, nombre)) : [];
  return (n?.textContent ?? '').trim();
}

/** El primer `xades:Cert` debe ser el certificado de KeyInfo (resumen y serial). */
function verificarSigningCertificate(props: Element, certificado: X509Certificate): string | null {
  const [primero] = Array.from(props.getElementsByTagNameNS(NS_XADES, 'Cert'));
  if (!primero) return 'SigningCertificate está vacío';
  const [digestMethod] = Array.from(primero.getElementsByTagNameNS(NS_DS, 'DigestMethod'));
  const hash = ALG_HASH[digestMethod?.getAttribute('Algorithm') ?? ''];
  if (!hash) return 'CertDigest con un algoritmo de resumen no previsto';
  const esperado = createHash(hash).update(certificado.raw).digest('base64');
  if (texto(primero, NS_DS, 'DigestValue') !== esperado) {
    return 'El resumen de SigningCertificate no corresponde al certificado de KeyInfo';
  }
  const serial = BigInt(`0x${certificado.serialNumber}`).toString(10);
  if (texto(primero, NS_DS, 'X509SerialNumber') !== serial) {
    return 'El serial de SigningCertificate no corresponde al certificado de KeyInfo';
  }
  return null;
}

function verificarPolitica(props: Element): string | null {
  const [politica] = Array.from(props.getElementsByTagNameNS(NS_XADES, 'SignaturePolicyId'));
  if (!politica) return 'Falta SignaturePolicyIdentifier';
  if (texto(politica, NS_XADES, 'Identifier') !== POLITICA_FIRMA_DIAN.identificador) {
    return 'La política de firma no es la DIAN v2';
  }
  if (texto(politica, NS_DS, 'DigestValue') !== POLITICA_FIRMA_DIAN.resumen) {
    return 'El resumen de la política de firma no coincide';
  }
  return null;
}
