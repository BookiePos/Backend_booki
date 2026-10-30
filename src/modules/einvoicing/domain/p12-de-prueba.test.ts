import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

/**
 * Fábrica de .p12 DE PRUEBA para los specs (no es un spec: `*.test.ts` queda
 * fuera del build y vitest no lo corre solo). Todo se genera en memoria: en el
 * repo no hay ni debe haber certificados reales.
 *
 * Las llaves salen de `node:crypto` (rápido) y se pasan a node-forge, que arma
 * los certificados y el PKCS#12.
 */

type Llaves = { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey };

const cache = new Map<string, Llaves>();

/** Par RSA 2048 reutilizado por nombre, para no generar uno por test. */
export function llavesDePrueba(nombre = 'titular'): Llaves {
  const hit = cache.get(nombre);
  if (hit) return hit;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const par = {
    privateKey: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
    publicKey: forge.pki.publicKeyFromPem(publicKey) as forge.pki.rsa.PublicKey,
  };
  cache.set(nombre, par);
  return par;
}

const DIA = 86_400_000;

export interface OpcionesP12 {
  password?: string;
  /** Atributos del sujeto. Por defecto, CN y el NIT en serialNumber. */
  sujeto?: forge.pki.CertificateField[];
  nit?: string;
  desde?: Date;
  hasta?: Date;
  autofirmado?: boolean;
  sha1?: boolean;
  /** `false` = sin extensión keyUsage. */
  keyUsage?: { nonRepudiation?: boolean; digitalSignature?: boolean; keyEncipherment?: boolean } | false;
  /** Mete la llave privada en el .p12 (por defecto sí). */
  conLlave?: boolean;
  /** Mete el certificado de la ECD de prueba en el .p12 (por defecto sí). */
  conCadena?: boolean;
  /** Firma el certificado con otra llave que no es la de la ECD declarada. */
  cadenaRota?: boolean;
}

const SUJETO_ECD: forge.pki.CertificateField[] = [
  { name: 'commonName', value: 'ECD DE PRUEBA BOOKIPOS' },
  { name: 'organizationName', value: 'ECD Prueba SA' },
  { name: 'countryName', value: 'CO' },
];

function certEcd(): forge.pki.Certificate {
  const ecd = llavesDePrueba('ecd');
  const c = forge.pki.createCertificate();
  c.publicKey = ecd.publicKey;
  c.serialNumber = '01';
  c.validity.notBefore = new Date(Date.now() - 365 * DIA);
  c.validity.notAfter = new Date(Date.now() + 10 * 365 * DIA);
  c.setSubject(SUJETO_ECD);
  c.setIssuer(SUJETO_ECD);
  c.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  c.sign(ecd.privateKey, forge.md.sha256.create());
  return c;
}

/** Arma un .p12 de prueba. Por defecto: válido, de la ECD de prueba, NIT 900123456. */
export function p12DePrueba(op: OpcionesP12 = {}): Buffer {
  const password = op.password ?? 'clave-de-prueba';
  const titular = llavesDePrueba('titular');
  const ecd = llavesDePrueba('ecd');
  const nit = op.nit ?? '900123456';
  const sujeto = op.sujeto ?? [
    { name: 'commonName', value: 'CRUNCHY PRUEBAS SAS' },
    { name: 'serialNumber', value: nit },
    { name: 'countryName', value: 'CO' },
  ];

  const cert = forge.pki.createCertificate();
  cert.publicKey = titular.publicKey;
  cert.serialNumber = '0a1b2c';
  cert.validity.notBefore = op.desde ?? new Date(Date.now() - 30 * DIA);
  cert.validity.notAfter = op.hasta ?? new Date(Date.now() + 365 * DIA);
  cert.setSubject(sujeto);
  cert.setIssuer(op.autofirmado ? sujeto : SUJETO_ECD);
  const ext: unknown[] = [];
  if (op.keyUsage !== false) {
    ext.push({ name: 'keyUsage', ...(op.keyUsage ?? { nonRepudiation: true, digitalSignature: true }) });
  }
  cert.setExtensions(ext);
  const md = op.sha1 ? forge.md.sha1.create() : forge.md.sha256.create();
  const firmante = op.autofirmado
    ? titular.privateKey
    : op.cadenaRota
      ? llavesDePrueba('impostor').privateKey
      : ecd.privateKey;
  cert.sign(firmante, md);

  const cadena = [cert];
  if (!op.autofirmado && op.conCadena !== false) cadena.push(certEcd());
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    op.conLlave === false ? null : titular.privateKey,
    cadena,
    password,
    { algorithm: '3des' },
  );
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}
