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
  /** Copias extra del certificado de la ECD (para el tope de cert bags). */
  certsExtra?: number;
  /** Iteraciones del MAC y de la llave cifrada (forge usa 2.048 por defecto). */
  iteraciones?: number;
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
  for (let i = 0; i < (op.certsExtra ?? 0); i++) cadena.push(certEcd());
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    op.conLlave === false ? null : titular.privateKey,
    cadena,
    password,
    { algorithm: '3des', count: op.iteraciones ?? 2048 },
  );
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

// ── Archivos alterados para los topes contra DoS ────────────────────────────
//
// Se editan en el ASN.1 sin recalcular nada: la validación debe rechazarlos
// antes de derivar una sola llave, así que el MAC o el cifrado roto no importan.

const A = forge.asn1;
type Nodo = forge.asn1.Asn1;

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_BOLSA_CERT = '1.2.840.113549.1.12.10.1.3';
const OID_BOLSA_LLAVE_CIFRADA = '1.2.840.113549.1.12.10.1.2';
const OID_PBES2 = '1.2.840.113549.1.5.13';

/** 2^31 - 1 iteraciones: horas de event loop bloqueado si nadie lo frena. */
export const ITERACIONES_ENORMES = 0x7fffffff;

function entero(n: number): Nodo {
  return A.create(A.Class.UNIVERSAL, A.Type.INTEGER, false, A.integerToDer(n).getBytes());
}
const hijos = (n: Nodo | undefined): Nodo[] => (n?.value as Nodo[]) ?? [];
const oid = (n: Nodo | undefined): string => A.derToOid(n?.value as string);
const aNodo = (b: Buffer): Nodo => A.fromDer(forge.util.createBuffer(b.toString('binary')));
const aBuffer = (n: Nodo): Buffer => Buffer.from(A.toDer(n).getBytes(), 'binary');

/** Edita los ContentInfo del authSafe y los vuelve a meter. */
function editarContenidos(p12: Buffer, fn: (infos: Nodo[]) => Nodo[], conMac = true): Buffer {
  const pfx = aNodo(p12);
  const octeto = hijos(hijos(hijos(pfx)[1])[1])[0]!;
  const infos = hijos(A.fromDer(octeto.value as string));
  octeto.value = A.toDer(A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, fn(infos))).getBytes();
  if (!conMac) pfx.value = hijos(pfx).slice(0, 2);
  return aBuffer(pfx);
}

/** SafeContents de un ContentInfo de datos en claro. */
function safeContents(info: Nodo): Nodo {
  return A.fromDer(hijos(hijos(info)[1])[0]!.value as string);
}

function infoDeDatos(safe: Nodo): Nodo {
  return A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
    A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(OID_DATA).getBytes()),
    A.create(A.Class.CONTEXT_SPECIFIC, 0, true, [
      A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, A.toDer(safe).getBytes()),
    ]),
  ]);
}

function infoCifrada(alg: Nodo, cifrado: string): Nodo {
  return A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
    A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(OID_ENCRYPTED_DATA).getBytes()),
    A.create(A.Class.CONTEXT_SPECIFIC, 0, true, [
      A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
        entero(0),
        A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
          A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(OID_DATA).getBytes()),
          alg,
          A.create(A.Class.CONTEXT_SPECIFIC, 0, false, cifrado),
        ]),
      ]),
    ]),
  ]);
}

const esDeCerts = (info: Nodo) =>
  oid(hijos(info)[0]) === OID_DATA && oid(hijos(hijos(safeContents(info))[0])[0]) === OID_BOLSA_CERT;

/**
 * Pasa los certificados a un EncryptedData (como lo exporta OpenSSL), cifrado
 * con la contraseña. Sin MAC: forge lo abre igual y así no hay que recalcularlo.
 */
export function conCertsCifrados(
  p12: Buffer,
  password: string,
  algoritmo: '3des' | 'aes128' = '3des',
  iteraciones = 2048,
): Buffer {
  return editarContenidos(
    p12,
    (infos) =>
      infos.map((info) => {
        if (!esDeCerts(info)) return info;
        const epki = forge.pki.encryptPrivateKeyInfo(safeContents(info), password, {
          algorithm: algoritmo,
          count: iteraciones,
        });
        return infoCifrada(hijos(epki)[0]!, hijos(epki)[1]!.value as string);
      }),
    false,
  );
}

/** Pone `n` iteraciones en el MAC del archivo. */
export function conIteracionesMac(p12: Buffer, n: number): Buffer {
  const pfx = aNodo(p12);
  const mac = hijos(pfx)[2]!;
  mac.value = [...hijos(mac).slice(0, 2), entero(n)];
  return aBuffer(pfx);
}

/** Pone `n` iteraciones en el PBE de la llave privada cifrada. */
export function conIteracionesLlave(p12: Buffer, n: number): Buffer {
  return editarContenidos(p12, (infos) =>
    infos.map((info) => {
      if (oid(hijos(info)[0]) !== OID_DATA) return info;
      const safe = safeContents(info);
      for (const bolsa of hijos(safe)) {
        if (oid(hijos(bolsa)[0]) !== OID_BOLSA_LLAVE_CIFRADA) continue;
        const params = hijos(hijos(hijos(hijos(bolsa)[1])[0])[0])[1]!;
        params.value = [hijos(params)[0]!, entero(n)];
      }
      return infoDeDatos(safe);
    }),
  );
}

/** Pone `n` iteraciones en el algoritmo del EncryptedData (PKCS#12 PBE o PBES2). */
export function conIteracionesContenido(p12Cifrado: Buffer, n: number): Buffer {
  return editarContenidos(
    p12Cifrado,
    (infos) =>
      infos.map((info) => {
        if (oid(hijos(info)[0]) !== OID_ENCRYPTED_DATA) return info;
        const alg = hijos(hijos(hijos(hijos(info)[1])[0])[1])[1]!;
        const params = hijos(alg)[1]!;
        if (oid(hijos(alg)[0]) === OID_PBES2) {
          const kdfParams = hijos(hijos(params)[0])[1]!;
          kdfParams.value = [hijos(kdfParams)[0]!, entero(n), ...hijos(kdfParams).slice(2)];
        } else {
          params.value = [hijos(params)[0]!, entero(n)];
        }
        return info;
      }),
    false,
  );
}

/** Repite `veces` cada EncryptedData del archivo (sin MAC). */
export function conContenidosRepetidos(p12Cifrado: Buffer, veces: number): Buffer {
  return editarContenidos(
    p12Cifrado,
    (infos) =>
      infos.flatMap((info) =>
        oid(hijos(info)[0]) === OID_ENCRYPTED_DATA ? Array.from({ length: veces }, () => info) : [info],
      ),
    false,
  );
}

/**
 * Le pone (o rehace) el MAC con la contraseña, SHA-1 como OpenSSL. Así un
 * archivo editado vuelve a ser un .p12 íntegro.
 */
export function conMac(p12: Buffer, password: string, iteraciones = 2048): Buffer {
  const pfx = aNodo(p12);
  const authSafe = hijos(pfx)[1]!;
  const datos = hijos(hijos(authSafe)[1])[0]!.value as string;
  const sal = forge.random.getBytesSync(8);
  const llave = forge.pkcs12.generateKey(password, forge.util.createBuffer(sal), 3, iteraciones, 20);
  const hmac = forge.hmac.create();
  hmac.start(forge.md.sha1.create(), llave);
  hmac.update(datos);
  const macData = A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
    A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
      A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
        A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer('1.3.14.3.2.26').getBytes()),
        A.create(A.Class.UNIVERSAL, A.Type.NULL, false, ''),
      ]),
      A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, hmac.digest().getBytes()),
    ]),
    A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, sal),
    entero(iteraciones),
  ]);
  pfx.value = [hijos(pfx)[0]!, authSafe, macData];
  return aBuffer(pfx);
}
