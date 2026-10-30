import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { dvNitValido } from '../../customers/domain/datos-fiscales';

/**
 * Validación del certificado .p12/.pfx de un emisor al subirlo (Fase 3). Lógica
 * pura: no toca la base ni el bucket. Quien llama decide qué hacer con el
 * resultado; aquí solo se responde «sirve para firmar como este NIT» o se
 * rechaza con un motivo.
 *
 * Reglas, en este orden:
 *   1. Abre con la contraseña (MAC del PKCS#12 verificada).
 *   2. Trae una llave privada RSA y el certificado que le corresponde.
 *   3. Está vigente: `notBefore` ≤ ahora < `notAfter`.
 *   4. No es autofirmado: lo emite otra entidad (una ECD). Si la cadena viene en
 *      el .p12, se comprueba además que el emisor de la cadena lo firmó.
 *   5. Declara uso de llave «no repudio» o «firma digital».
 *   6. Su firma no es SHA-1 (ni MD5).
 *   7. El NIT del titular coincide con el del emisor (ver `nitsDelCertificado`).
 *
 * Los mensajes de rechazo dicen QUÉ está mal, nunca el contenido del
 * certificado (ni el NIT que trae, ni el nombre, ni fechas exactas): el mensaje
 * viaja en la respuesta y en la auditoría.
 *
 * LÍMITE: no se valida la cadena contra las raíces de las ECD acreditadas por
 * ONAC (no se empaquetan sus certificados raíz). «Emitido por una ECD» queda en
 * «no autofirmado y, si trae la cadena, la cadena cuadra». La DIAN valida la
 * cadena de confianza al recibir el primer documento firmado.
 */

export type MotivoRechazoCertificado =
  | 'formato'
  | 'password'
  | 'sin-llave'
  | 'sin-certificado'
  | 'llave-no-rsa'
  | 'aun-no-vigente'
  | 'vencido'
  | 'autofirmado'
  | 'cadena'
  | 'uso-llave'
  | 'algoritmo-debil'
  | 'nit';

const MENSAJES: Record<MotivoRechazoCertificado, string> = {
  formato: 'El archivo no es un certificado .p12/.pfx válido.',
  password: 'La contraseña del certificado no es correcta.',
  'sin-llave': 'El certificado no trae la llave privada: exporta el .p12 incluyendo la llave privada.',
  'sin-certificado': 'El archivo no trae el certificado que corresponde a su llave privada.',
  'llave-no-rsa': 'La llave del certificado no es RSA: la DIAN exige firma RSA-SHA256.',
  'aun-no-vigente': 'El certificado todavía no está vigente.',
  vencido: 'El certificado está vencido.',
  autofirmado:
    'El certificado es autofirmado: debe emitirlo una entidad de certificación digital (ECD) acreditada.',
  cadena: 'La cadena del certificado no cuadra: el emisor incluido no lo firmó.',
  'uso-llave': 'El certificado no está habilitado para firma digital (uso «no repudio» o «firma digital»).',
  'algoritmo-debil': 'El certificado está firmado con SHA-1 o MD5, que la DIAN no acepta.',
  nit: 'El NIT del titular del certificado no coincide con el NIT del emisor.',
};

/** Rechazo de un certificado al subirlo. El mensaje es apto para el usuario. */
export class CertificadoInvalidoError extends Error {
  constructor(readonly motivo: MotivoRechazoCertificado) {
    super(MENSAJES[motivo]);
    this.name = 'CertificadoInvalidoError';
  }
}

/** Lo que se guarda del certificado validado. Nada de esto es secreto. */
export interface CertificadoValidado {
  desde: Date;
  venceAt: Date;
  /** Nombre del titular (CN u O), sin números de identificación. */
  titular: string;
  /** Nombre de quien lo emitió (la ECD), para la auditoría. */
  emisorCertificado: string;
  /** SHA-256 del certificado en DER, hex en minúsculas. */
  huellaSha256: string;
}

// Tipos de bolsa del PKCS#12 (RFC 7292 §4.2).
const OID_BOLSA_LLAVE = '1.2.840.113549.1.12.10.1.1';
const OID_BOLSA_LLAVE_CIFRADA = '1.2.840.113549.1.12.10.1.2';
const OID_BOLSA_CERT = '1.2.840.113549.1.12.10.1.3';

const OID_SHA1_RSA = '1.2.840.113549.1.1.5';
const OID_MD5_RSA = '1.2.840.113549.1.1.4';
const OID_MD2_RSA = '1.2.840.113549.1.1.2';
const OID_SHA1_DSA = '1.2.840.10040.4.3';
const OID_SHA1_ECDSA = '1.2.840.10045.4.1';
const ALGORITMOS_DEBILES = new Set([OID_SHA1_RSA, OID_MD5_RSA, OID_MD2_RSA, OID_SHA1_DSA, OID_SHA1_ECDSA]);

/**
 * Atributos del sujeto donde las ECD colombianas ponen el NIT:
 *   - 2.5.4.5   serialNumber: GSE y Andes SCD (a veces «NIT 900123456-7»).
 *   - 2.5.4.45  x500UniqueIdentifier: algunos perfiles de persona jurídica.
 *   - 2.5.4.97  organizationIdentifier: perfiles ETSI («NITCO-900123456»).
 *   - 1.3.6.1.4.1.23267.*  arco privado de Certicámara (2.3 = NIT de la empresa,
 *     2.1/2.2 = documento de la persona); se leen todos los del arco.
 *   - 2.5.4.3   commonName y 2.5.4.10 organizationName: hay ECD que escriben el
 *     NIT en el nombre («EMPRESA SAS NIT 900123456»).
 * Las extensiones no se leen: ninguna ECD acreditada pone ahí el NIT del titular.
 */
const OIDS_NIT = new Set(['2.5.4.5', '2.5.4.45', '2.5.4.97', '2.5.4.3', '2.5.4.10']);
const ARCO_CERTICAMARA = '1.3.6.1.4.1.23267.';

/** Secuencias de dígitos (con puntos y DV tras guion opcionales) de un texto. */
const RE_NIT = /(\d[\d.]{3,}\d)(?:\s*-\s*(\d))?/g;

type Atributo = { type?: string; value?: unknown };

function texto(valor: unknown): string {
  if (typeof valor === 'string') return valor;
  if (Array.isArray(valor)) return valor.map(texto).join(' ');
  return '';
}

/** Números de identificación candidatos del sujeto del certificado (solo dígitos). */
export function nitsDelCertificado(cert: forge.pki.Certificate): string[] {
  const salida = new Set<string>();
  for (const attr of cert.subject.attributes as Atributo[]) {
    const oid = attr.type ?? '';
    if (!OIDS_NIT.has(oid) && !oid.startsWith(ARCO_CERTICAMARA)) continue;
    for (const m of texto(attr.value).matchAll(RE_NIT)) {
      const base = (m[1] ?? '').replace(/\./g, '');
      if (base.length >= 5) salida.add(base);
      if (m[2] !== undefined) salida.add(`${base}${m[2]}`);
    }
  }
  return [...salida];
}

/**
 * ¿El número del certificado es el NIT del emisor? Acepta el NIT tal cual o con
 * el DV pegado de cualquiera de los dos lados, solo si ese dígito ES el DV
 * correcto (módulo 11): así un número que solo comparte los primeros dígitos
 * no pasa por el mismo NIT.
 */
export function nitCoincide(candidato: string, nitNorm: string): boolean {
  if (!candidato || !nitNorm) return false;
  if (candidato === nitNorm) return true;
  if (candidato.length === nitNorm.length + 1 && candidato.startsWith(nitNorm)) {
    return dvNitValido(nitNorm, candidato.slice(-1));
  }
  if (nitNorm.length === candidato.length + 1 && nitNorm.startsWith(candidato)) {
    return dvNitValido(candidato, nitNorm.slice(-1));
  }
  return false;
}

function nombreDe(dn: forge.pki.Certificate['subject']): string {
  const cn = dn.getField('CN') as Atributo | null;
  const o = dn.getField('O') as Atributo | null;
  return (texto(cn?.value) || texto(o?.value)).trim();
}

/** Nombre sin números de identificación (5+ dígitos) y acotado. */
function sinIdentificaciones(nombre: string): string {
  return nombre
    .replace(/\b(NIT|C\.?C\.?|CC|NITCO)\b[\s:.-]*/gi, ' ')
    .replace(/\d[\d.\s-]{3,}\d/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 160);
}

function mismaLlave(cert: forge.pki.Certificate, llave: forge.pki.rsa.PrivateKey): boolean {
  const pub = cert.publicKey as forge.pki.rsa.PublicKey | undefined;
  return !!pub?.n && pub.n.equals(llave.n) && pub.e.equals(llave.e);
}

/** Abre el PKCS#12. Distingue «no es un .p12» de «contraseña mala». */
function abrir(contenido: Buffer, password: string): forge.pkcs12.Pkcs12Pfx {
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(contenido.toString('binary')));
  } catch {
    throw new CertificadoInvalidoError('formato');
  }
  try {
    return forge.pkcs12.pkcs12FromAsn1(asn1, true, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/MAC could not be verified|Invalid password|decrypt/i.test(msg)) {
      throw new CertificadoInvalidoError('password');
    }
    // forge solo lee llaves RSA: un .p12 con llave EC falla al leer la llave.
    if (/OID is not RSA|not RSA|Cannot read (private|public) key/i.test(msg)) {
      throw new CertificadoInvalidoError('llave-no-rsa');
    }
    throw new CertificadoInvalidoError('formato');
  }
}

/**
 * Valida el .p12 contra el NIT del emisor. Lanza `CertificadoInvalidoError`
 * con el primer motivo de rechazo; si pasa, devuelve lo que se guarda.
 */
export function validarCertificadoP12(
  contenido: Buffer,
  password: string,
  nitNormEmisor: string,
  ahora: Date = new Date(),
): CertificadoValidado {
  const p12 = abrir(contenido, password);

  const bolsas = (tipo: string): forge.pkcs12.Bag[] => p12.getBags({ bagType: tipo })[tipo] ?? [];
  const bolsasLlave = [...bolsas(OID_BOLSA_LLAVE_CIFRADA), ...bolsas(OID_BOLSA_LLAVE)];
  const llaves = bolsasLlave
    .map((b) => b.key as forge.pki.rsa.PrivateKey | undefined)
    .filter((k): k is forge.pki.rsa.PrivateKey => !!k);
  if (llaves.length === 0) {
    throw new CertificadoInvalidoError(bolsasLlave.length > 0 ? 'llave-no-rsa' : 'sin-llave');
  }

  const certs = bolsas(OID_BOLSA_CERT)
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);
  let cert: forge.pki.Certificate | undefined;
  for (const llave of llaves) {
    cert = certs.find((c) => mismaLlave(c, llave));
    if (cert) break;
  }
  if (!cert) throw new CertificadoInvalidoError('sin-certificado');

  const { notBefore, notAfter } = cert.validity;
  if (ahora.getTime() < notBefore.getTime()) throw new CertificadoInvalidoError('aun-no-vigente');
  if (ahora.getTime() >= notAfter.getTime()) throw new CertificadoInvalidoError('vencido');

  if (cert.isIssuer(cert)) throw new CertificadoInvalidoError('autofirmado');
  const emisorEnCadena = certs.find((c) => c !== cert && c.subject.hash === cert!.issuer.hash);
  if (emisorEnCadena) {
    let firmado = false;
    try {
      firmado = emisorEnCadena.verify(cert);
    } catch {
      firmado = false;
    }
    if (!firmado) throw new CertificadoInvalidoError('cadena');
  }

  const uso = cert.getExtension('keyUsage') as
    | { nonRepudiation?: boolean; digitalSignature?: boolean }
    | null;
  if (!uso || !(uso.nonRepudiation || uso.digitalSignature)) {
    throw new CertificadoInvalidoError('uso-llave');
  }

  if (ALGORITMOS_DEBILES.has(cert.signatureOid ?? '')) {
    throw new CertificadoInvalidoError('algoritmo-debil');
  }

  if (!nitsDelCertificado(cert).some((n) => nitCoincide(n, nitNormEmisor))) {
    throw new CertificadoInvalidoError('nit');
  }

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    desde: notBefore,
    venceAt: notAfter,
    titular: sinIdentificaciones(nombreDe(cert.subject)) || 'Titular sin nombre',
    emisorCertificado: sinIdentificaciones(nombreDe(cert.issuer)) || 'ECD sin nombre',
    huellaSha256: createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex'),
  };
}

/** Días antes del vencimiento en que se empieza a avisar. */
export const DIAS_AVISO_CERTIFICADO = 30;

export type AvisoCertificado = 'por-vencer' | 'vencido';

/**
 * Aviso del certificado según su vencimiento: `vencido` si ya pasó,
 * `por-vencer` si vence en 30 días o menos, `null` si no hay que avisar (o no
 * hay certificado).
 */
export function avisoCertificado(
  venceAt: Date | null | undefined,
  ahora: Date = new Date(),
): AvisoCertificado | null {
  if (!(venceAt instanceof Date) || Number.isNaN(venceAt.getTime())) return null;
  const restante = venceAt.getTime() - ahora.getTime();
  if (restante <= 0) return 'vencido';
  if (restante <= DIAS_AVISO_CERTIFICADO * 86_400_000) return 'por-vencer';
  return null;
}
