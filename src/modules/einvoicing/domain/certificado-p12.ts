import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { separarNitConDv } from '../../customers/domain/datos-fiscales';

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
  | 'nit'
  | 'demasiados-certificados'
  | 'iteraciones';

// ── Topes contra DoS (ver `revisarTopesP12`) ────────────────────────────────

/** Tope de iteraciones de MAC, PBE y PBKDF2. Una ECD usa 2.048-10.000. */
export const MAX_ITERACIONES_P12 = 100_000;
/** Tope de certificados (cert bags). Un .p12 real trae 1-4. */
export const MAX_CERT_BAGS_P12 = 10;
const MAX_BOLSAS_P12 = 32;
const MAX_CONTENIDOS_P12 = 16;

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
  'demasiados-certificados': `El archivo trae demasiados certificados (más de ${MAX_CERT_BAGS_P12}): exporta solo el tuyo y su cadena.`,
  iteraciones:
    'El archivo usa un cifrado con demasiadas iteraciones: vuelve a exportar el .p12 con las opciones por defecto.',
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
 * Atributos del sujeto donde las ECD colombianas ponen el NIT, en dos grupos.
 *
 * NIT de empresa (si alguno trae un número, SOLO se miran estos):
 *   - 2.5.4.5   serialNumber: GSE y Andes SCD (a veces «NIT 900123456-7»).
 *   - 2.5.4.97  organizationIdentifier: perfiles ETSI («NITCO-900123456»).
 *   - 1.3.6.1.4.1.23267.2.3  Certicámara: NIT de la empresa.
 * Respaldo, solo si no hay ninguno de los anteriores:
 *   - 2.5.4.45  x500UniqueIdentifier.
 *   - 1.3.6.1.4.1.23267.*  resto del arco de Certicámara (2.1/2.2 = documento
 *     de la persona: es lo que trae un certificado de persona natural).
 *   - 2.5.4.3   commonName y 2.5.4.10 organizationName («EMPRESA SAS NIT …»).
 * Así la cédula del representante legal que viene en el certificado de una
 * empresa no pasa por el NIT de esa persona como persona natural.
 * Las extensiones no se leen: ninguna ECD acreditada pone ahí el NIT del titular.
 */
const OIDS_NIT_EMPRESA = new Set(['2.5.4.5', '2.5.4.97', '1.3.6.1.4.1.23267.2.3']);
const OIDS_NIT_RESPALDO = new Set(['2.5.4.45', '2.5.4.3', '2.5.4.10']);
const ARCO_CERTICAMARA = '1.3.6.1.4.1.23267.';

/** Secuencias de dígitos (con puntos y DV tras guion opcionales) de un texto. */
const RE_NIT = /(\d[\d.]{3,}\d)(?:\s*-\s*(\d))?/g;

type Atributo = { type?: string; value?: unknown };

function texto(valor: unknown): string {
  if (typeof valor === 'string') return valor;
  if (Array.isArray(valor)) return valor.map(texto).join(' ');
  return '';
}

/** Un número de identificación leído del certificado: base y, si venía con guion, DV. */
export interface NitLeido {
  base: string;
  dv?: string;
}

function numerosDe(valor: unknown): NitLeido[] {
  const salida: NitLeido[] = [];
  for (const m of texto(valor).matchAll(RE_NIT)) {
    const base = (m[1] ?? '').replace(/\./g, '');
    if (base.length < 5) continue;
    salida.push(m[2] !== undefined ? { base, dv: m[2] } : { base });
  }
  return salida;
}

/** Números de identificación candidatos del sujeto, con la prioridad de arriba. */
export function nitsDelCertificado(cert: forge.pki.Certificate): NitLeido[] {
  const empresa: NitLeido[] = [];
  const respaldo: NitLeido[] = [];
  for (const attr of cert.subject.attributes as Atributo[]) {
    const oid = attr.type ?? '';
    if (OIDS_NIT_EMPRESA.has(oid)) empresa.push(...numerosDe(attr.value));
    else if (OIDS_NIT_RESPALDO.has(oid) || oid.startsWith(ARCO_CERTICAMARA)) {
      respaldo.push(...numerosDe(attr.value));
    }
  }
  return empresa.length > 0 ? empresa : respaldo;
}

/** NIT del emisor: base sin DV y el DV conocido, si lo hay. */
export interface NitEmisor {
  base: string;
  dv?: string;
}

/**
 * Arma el NIT del emisor desde lo guardado: `nitNorm` (base) y el DV de
 * `nitDv` o, si no está, el que venga tras el guion en `nit`.
 */
export function nitDelEmisor(e: { nitNorm: string; nit?: string; nitDv?: string }): NitEmisor {
  const sep = separarNitConDv(e.nit);
  const dv = (e.nitDv?.replace(/\D/g, '') || sep?.dv) ?? undefined;
  return dv ? { base: e.nitNorm, dv } : { base: e.nitNorm };
}

/**
 * ¿El número del certificado es el NIT del emisor? Se compara por la base:
 *   - con DV tras guion: la base debe ser la del emisor y el DV, si el emisor
 *     lo tiene, el mismo. «90012345-6» NO es «900123456» aunque pegados se
 *     escriban igual.
 *   - sin guion: la base tal cual, o la base con el DV pegado solo si ese
 *     dígito es el DV CONOCIDO del emisor (sin DV conocido no se adivina).
 */
export function nitCoincide(leido: NitLeido, emisor: NitEmisor): boolean {
  if (!leido.base || !emisor.base) return false;
  if (leido.dv !== undefined) {
    return leido.base === emisor.base && (emisor.dv === undefined || leido.dv === emisor.dv);
  }
  if (leido.base === emisor.base) return true;
  return emisor.dv !== undefined && leido.base === `${emisor.base}${emisor.dv}`;
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

// ── Revisión previa del PKCS#12 (DoS) ───────────────────────────────────────
//
// node-forge deriva las llaves (MAC, PBE, PBKDF2) con las iteraciones que diga
// el archivo, en JS y bloqueando el event loop: un .p12 de 50 KB con 2^31
// iteraciones congela el API durante horas. Antes de que forge use la
// contraseña se recorre el ASN.1 y se rechaza lo que pase de los topes.

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_PBES2 = '1.2.840.113549.1.5.13';
const ARCO_PBE_PKCS12 = '1.2.840.113549.1.12.1.';
const ARCO_PBE_PKCS5 = '1.2.840.113549.1.5.';

type Nodo = forge.asn1.Asn1;
type CifradorPbe = {
  update(b: forge.util.ByteStringBuffer): void;
  finish(): boolean;
  output: forge.util.ByteStringBuffer;
};

/** `pki.pbe` existe en runtime, pero @types/node-forge no lo declara. */
function pbe(): { getCipher(oid: string, params: Nodo, password: string): CifradorPbe } {
  return (forge.pki as unknown as { pbe: ReturnType<typeof pbe> }).pbe;
}

function hijos(n: Nodo | undefined): Nodo[] {
  if (!n || !Array.isArray(n.value)) throw new CertificadoInvalidoError('formato');
  return n.value;
}

/** Bytes de un OCTET STRING, primitivo o troceado (BER). */
function octetos(n: Nodo | undefined): string {
  if (!n) throw new CertificadoInvalidoError('formato');
  return typeof n.value === 'string' ? n.value : hijos(n).map(octetos).join('');
}

function oidDe(n: Nodo | undefined): string {
  if (!n || typeof n.value !== 'string') throw new CertificadoInvalidoError('formato');
  return forge.asn1.derToOid(n.value);
}

/** Entero ASN.1 sin desbordar: más de 6 bytes ya pasa de cualquier tope. */
function entero(n: Nodo | undefined): number {
  if (!n || typeof n.value !== 'string') throw new CertificadoInvalidoError('formato');
  if (n.value.length > 6) return Number.POSITIVE_INFINITY;
  let v = 0;
  for (let i = 0; i < n.value.length; i++) v = v * 256 + n.value.charCodeAt(i);
  return v;
}

function topeIteraciones(iteraciones: number): void {
  if (!(iteraciones <= MAX_ITERACIONES_P12)) throw new CertificadoInvalidoError('iteraciones');
}

/** Revisa las iteraciones de un AlgorithmIdentifier de PBE (PKCS#12, PBES1 o PBES2). */
function revisarAlgoritmo(alg: Nodo | undefined): void {
  const [oidNodo, params] = hijos(alg);
  const oid = oidDe(oidNodo);
  if (oid === OID_PBES2) {
    // PBES2-params ::= SEQUENCE { keyDerivationFunc, encryptionScheme }
    // PBKDF2-params ::= SEQUENCE { salt, iterationCount, ... }
    const kdf = hijos(params)[0];
    topeIteraciones(entero(hijos(hijos(kdf)[1])[1]));
    return;
  }
  if (oid.startsWith(ARCO_PBE_PKCS12) || oid.startsWith(ARCO_PBE_PKCS5)) {
    // pkcs-12PbeParams / PBEParameter ::= SEQUENCE { salt, iterations }
    topeIteraciones(entero(hijos(params)[1]));
    return;
  }
  // Algoritmo desconocido: forge tampoco lo sabría descifrar.
  throw new CertificadoInvalidoError('formato');
}

/** Cuenta las bolsas de un SafeContents y revisa las llaves cifradas. */
function revisarBolsas(safeContents: Nodo, cuenta: { bolsas: number; certs: number }): void {
  for (const bolsa of hijos(safeContents)) {
    const [idNodo, valor] = hijos(bolsa);
    const id = oidDe(idNodo);
    cuenta.bolsas++;
    if (cuenta.bolsas > MAX_BOLSAS_P12) throw new CertificadoInvalidoError('demasiados-certificados');
    if (id === OID_BOLSA_CERT) {
      cuenta.certs++;
      if (cuenta.certs > MAX_CERT_BAGS_P12) throw new CertificadoInvalidoError('demasiados-certificados');
    } else if (id === OID_BOLSA_LLAVE_CIFRADA) {
      // [0] EXPLICIT EncryptedPrivateKeyInfo ::= SEQUENCE { algoritmo, datos }
      revisarAlgoritmo(hijos(hijos(valor)[0])[0]);
    }
    // Otras bolsas (llave en claro, CRL, secretos) no derivan llaves; cuentan
    // para el tope de bolsas.
  }
}

/**
 * Topes de iteraciones y de bolsas ANTES de que forge use la contraseña.
 * Primero todo lo visible (MAC, algoritmo de cada EncryptedData, llaves de los
 * contenidos en claro); con eso ya acotado se descifra cada EncryptedData
 * para revisar las bolsas de dentro, que forge descifraría igual después.
 */
export function revisarTopesP12(pfx: Nodo, password: string): void {
  try {
    const [, authSafe, macData] = hijos(pfx);
    // MacData ::= SEQUENCE { mac, macSalt, iterations INTEGER DEFAULT 1 }
    if (macData) {
      const iter = hijos(macData)[2];
      if (iter) topeIteraciones(entero(iter));
    }
    const [tipo, contenido] = hijos(authSafe);
    if (oidDe(tipo) !== OID_DATA) throw new CertificadoInvalidoError('formato');
    const infos = hijos(forge.asn1.fromDer(octetos(hijos(contenido)[0])));
    if (infos.length > MAX_CONTENIDOS_P12) throw new CertificadoInvalidoError('demasiados-certificados');

    const cuenta = { bolsas: 0, certs: 0 };
    const cifrados: Array<{ alg: Nodo; datos: Nodo | undefined }> = [];
    for (const info of infos) {
      const [oidNodo, c0] = hijos(info);
      const interior = hijos(c0)[0];
      const oid = oidDe(oidNodo);
      if (oid === OID_DATA) {
        revisarBolsas(forge.asn1.fromDer(octetos(interior)), cuenta);
      } else if (oid === OID_ENCRYPTED_DATA) {
        // EncryptedData ::= SEQUENCE { version, EncryptedContentInfo }
        // EncryptedContentInfo ::= SEQUENCE { contentType, algoritmo, [0] datos }
        const eci = hijos(hijos(interior)[1]);
        revisarAlgoritmo(eci[1]);
        cifrados.push({ alg: eci[1]!, datos: eci[2] });
      } else {
        throw new CertificadoInvalidoError('formato');
      }
    }

    for (const { alg, datos } of cifrados) {
      const [oidNodo, params] = hijos(alg);
      const cifrador = pbe().getCipher(oidDe(oidNodo), params!, password);
      cifrador.update(forge.util.createBuffer(octetos(datos)));
      if (!cifrador.finish()) throw new CertificadoInvalidoError('password');
      let interior: Nodo;
      try {
        interior = forge.asn1.fromDer(cifrador.output.getBytes());
      } catch {
        // Relleno válido por azar con una contraseña equivocada.
        throw new CertificadoInvalidoError('password');
      }
      revisarBolsas(interior, cuenta);
    }
  } catch (err) {
    if (err instanceof CertificadoInvalidoError) throw err;
    throw new CertificadoInvalidoError('formato');
  }
}

/** Abre el PKCS#12. Distingue «no es un .p12» de «contraseña mala». */
function abrir(contenido: Buffer, password: string): forge.pkcs12.Pkcs12Pfx {
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(contenido.toString('binary')));
  } catch {
    throw new CertificadoInvalidoError('formato');
  }
  revisarTopesP12(asn1, password);
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
  /** NIT del emisor (`nitDelEmisor`); un string es la base sin DV conocido. */
  nitEmisor: NitEmisor | string,
  ahora: Date = new Date(),
): CertificadoValidado {
  const emisorNit: NitEmisor = typeof nitEmisor === 'string' ? { base: nitEmisor } : nitEmisor;
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

  if (!nitsDelCertificado(cert).some((n) => nitCoincide(n, emisorNit))) {
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
