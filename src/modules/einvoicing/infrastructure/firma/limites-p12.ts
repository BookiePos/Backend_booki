import * as forge from 'node-forge';

/**
 * Límites de un .p12 ANTES de descifrarlo. node-forge corre el PBKDF/PBE en JS
 * puro y en el hilo principal: un archivo con millones de iteraciones (en el MAC o
 * en cualquier bolsa cifrada) dejaría la función de Vercel colgada hasta su tope.
 * Un .p12 de una ECD trae 2 048–10 000 iteraciones (OpenSSL 3 usa 2 048; las
 * herramientas de Windows, 2 000) y pesa unos pocos KB con la cadena completa.
 *
 * La usan la firma (`abrirP12`) y la carga del certificado: misma regla en ambas.
 */

export const LIMITES_P12 = Object.freeze({
  bytes: 64 * 1024,
  iteraciones: 100_000,
  bolsasCertificado: 10,
});

export class P12FueraDeLimites extends Error {
  constructor(readonly motivo: 'tamano' | 'estructura' | 'iteraciones' | 'certificados') {
    super(`El .p12 está fuera de los límites admitidos (${motivo})`);
    this.name = 'P12FueraDeLimites';
  }
}

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
/** PBE de PKCS#12 (1.2.840.113549.1.12.1.1–6) y PBES1 de PKCS#5. */
const OID_PBE_DIRECTO = /^(1\.2\.840\.113549\.1\.12\.1\.[1-6]|1\.2\.840\.113549\.1\.5\.(1|3|4|6|10|11))$/;

type Nodo = forge.asn1.Asn1;
const { Class, Type } = forge.asn1;

const hijos = (n: Nodo | undefined): Nodo[] => (n && Array.isArray(n.value) ? (n.value as Nodo[]) : []);
const esTipo = (n: Nodo | undefined, tipo: number): n is Nodo =>
  Boolean(n) && n!.tagClass === Class.UNIVERSAL && n!.type === tipo;
const oid = (n: Nodo | undefined): string | null =>
  esTipo(n, Type.OID) && typeof n.value === 'string' ? forge.asn1.derToOid(n.value) : null;

/** Entero DER no negativo; más de 4 bytes ya es absurdo para un contador. */
function entero(n: Nodo | undefined): number {
  if (!esTipo(n, Type.INTEGER) || typeof n.value !== 'string') throw new P12FueraDeLimites('estructura');
  let inicio = 0;
  while (inicio < n.value.length && n.value.charCodeAt(inicio) === 0) inicio += 1;
  const bytes = n.value.slice(inicio);
  if (bytes.length > 4) return Number.POSITIVE_INFINITY;
  let v = 0;
  for (const c of bytes) v = v * 256 + c.charCodeAt(0);
  return v;
}

function exigirIteraciones(n: number): void {
  if (!(n <= LIMITES_P12.iteraciones)) throw new P12FueraDeLimites('iteraciones');
}

/** Contenido de un `[0] EXPLICIT OCTET STRING`, primitivo o fragmentado (BER). */
function octetos(n: Nodo | undefined): string {
  if (!n) return '';
  if (typeof n.value === 'string') return n.value;
  return hijos(n).map(octetos).join('');
}

/** Revisa un AlgorithmIdentifier de cifrado por contraseña, si lo es. */
function revisarAlgoritmo(alg: Nodo | undefined): void {
  const [idNodo, params] = hijos(alg);
  const id = oid(idNodo);
  if (!id) return;
  if (OID_PBE_DIRECTO.test(id)) {
    exigirIteraciones(entero(hijos(params)[1]));
  } else if (id === OID_PBES2) {
    const [kdf] = hijos(params);
    const [kdfId, kdfParams] = hijos(kdf);
    if (oid(kdfId) !== OID_PBKDF2) throw new P12FueraDeLimites('estructura');
    exigirIteraciones(entero(hijos(kdfParams)[1]));
  }
}

/** SafeContents en claro: cuenta los certificados y revisa las llaves cifradas. */
function revisarSafeContents(der: string, cuenta: { certs: number }): void {
  const safeContents = forge.asn1.fromDer(der, false);
  for (const bolsa of hijos(safeContents)) {
    const [bagId, valor] = hijos(bolsa);
    const id = oid(bagId);
    if (id === OID_CERT_BAG) {
      cuenta.certs += 1;
      if (cuenta.certs > LIMITES_P12.bolsasCertificado) throw new P12FueraDeLimites('certificados');
    }
    // pkcs8ShroudedKeyBag: EncryptedPrivateKeyInfo { encryptionAlgorithm, encryptedData }.
    const [contenido] = hijos(valor);
    revisarAlgoritmo(hijos(contenido)[0]);
  }
}

/**
 * Lanza `P12FueraDeLimites` si el archivo pesa demasiado, si su MAC o alguna
 * bolsa pide más de `LIMITES_P12.iteraciones`, o si trae más certificados de los
 * admitidos en las bolsas en claro (las cifradas se cuentan al abrirlas).
 * Solo lee la estructura: no descifra nada ni necesita la contraseña.
 */
export function revisarLimitesP12(p12: Buffer): void {
  if (p12.length === 0 || p12.length > LIMITES_P12.bytes) throw new P12FueraDeLimites('tamano');
  let pfx: Nodo;
  try {
    pfx = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')), false);
  } catch {
    throw new P12FueraDeLimites('estructura');
  }
  try {
    const [, authSafe, macData] = hijos(pfx);
    if (macData) {
      const iter = hijos(macData)[2];
      exigirIteraciones(iter ? entero(iter) : 1);
    }
    const [tipo, envoltura] = hijos(authSafe);
    if (oid(tipo) !== OID_DATA) throw new P12FueraDeLimites('estructura');
    const authenticatedSafe = forge.asn1.fromDer(octetos(hijos(envoltura)[0]), false);
    const cuenta = { certs: 0 };
    for (const info of hijos(authenticatedSafe)) {
      const [tipoInfo, contenido] = hijos(info);
      const id = oid(tipoInfo);
      if (id === OID_DATA) {
        revisarSafeContents(octetos(hijos(contenido)[0]), cuenta);
      } else if (id === OID_ENCRYPTED_DATA) {
        // EncryptedData { version, EncryptedContentInfo { contentType, algoritmo, [0] datos } }
        const [, encInfo] = hijos(hijos(contenido)[0]);
        revisarAlgoritmo(hijos(encInfo)[1]);
      } else {
        throw new P12FueraDeLimites('estructura');
      }
    }
  } catch (e) {
    if (e instanceof P12FueraDeLimites) throw e;
    throw new P12FueraDeLimites('estructura');
  }
}
