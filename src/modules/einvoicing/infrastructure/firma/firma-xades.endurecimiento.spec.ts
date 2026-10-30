import { generateKeyPairSync, X509Certificate } from 'crypto';
import * as forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALG_C14N, ALG_RESUMEN_SHA256 } from '../../domain/firma/firma.constants';
import { firmarXml, verificarFirma } from './firma-xades';
import { MAX_CERT_BAGS_P12 } from '../../domain/certificado-p12';
import {
  conIteracionesLlave,
  conIteracionesMac,
  conMac,
  ITERACIONES_ENORMES,
} from '../../domain/p12-de-prueba.test';
import { abrirP12, ErrorFirma, MAX_BYTES_P12_FIRMA } from './material-p12';

/**
 * Revisión de seguridad del #94: límites del .p12 (DoS por iteraciones o por
 * número de bolsas), DOCTYPE, tope de 5 MB, SHA-256 obligatorio en las
 * referencias, huella esperada y atributos con tab o salto de línea.
 * El .p12 se arma aquí (autofirmado), nunca uno real.
 */
const PASSWORD = 'clave-de-prueba';
const UUID = '0f8a3c2e-1b7d-4e5f-9a6b-2c3d4e5f6a7b';

const INVOICE =
  '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
  ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
  ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">' +
  '<ext:UBLExtensions>' +
  '<ext:UBLExtension><ext:ExtensionContent><x/></ext:ExtensionContent></ext:UBLExtension>' +
  '<ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>' +
  '</ext:UBLExtensions>' +
  '<cbc:Note>Nota</cbc:Note>' +
  '<cbc:PayableAmount currencyID="COP">100.00</cbc:PayableAmount>' +
  '</Invoice>';

let p12: Buffer;
let firmante: forge.pki.Certificate;
let llave: forge.pki.rsa.PrivateKey;
let firmado: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  llave = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
  const c = forge.pki.createCertificate();
  c.serialNumber = '2a';
  c.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  c.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  c.validity.notAfter = new Date('2028-01-01T00:00:00Z');
  const nombre = [{ name: 'commonName', value: 'Emisor Autofirmado de Prueba' }];
  c.setSubject(nombre);
  c.setIssuer(nombre);
  c.sign(llave, forge.md.sha256.create());
  firmante = c;
  p12 = Buffer.from(
    forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(llave, [c], PASSWORD, { algorithm: '3des' })).getBytes(),
    'binary',
  );
  firmado = firmarXml(INVOICE, { p12, password: PASSWORD }, { uuid: UUID });
});

describe('verificarFirma: endurecimiento', () => {
  it('con huellaEsperada solo acepta el certificado del emisor', () => {
    const huella = new X509Certificate(forge.pki.certificateToPem(firmante)).fingerprint256;
    expect(verificarFirma(firmado)).toEqual({ valida: true });
    expect(verificarFirma(firmado, huella)).toEqual({ valida: true });
    expect(verificarFirma(firmado, huella.replace(/:/g, '').toLowerCase())).toEqual({ valida: true });
    expect(verificarFirma(firmado, 'ab'.repeat(32))).toEqual({
      valida: false,
      motivo: 'El certificado de la firma no es el esperado',
    });
    expect(verificarFirma(firmado, 'no-es-huella').valida).toBe(false);
  });

  it('exige xmlenc#sha256 en las tres referencias', () => {
    const original =
      `<ds:Reference URI="#xmldsig-${UUID}-keyinfo"><ds:Transforms><ds:Transform Algorithm="${ALG_C14N}"/>` +
      `</ds:Transforms><ds:DigestMethod Algorithm="${ALG_RESUMEN_SHA256}"/>`;
    expect(firmado).toContain(original);
    const sha1 = firmado.replace(
      original,
      original.replace(ALG_RESUMEN_SHA256, 'http://www.w3.org/2000/09/xmldsig#sha1'),
    );
    expect(verificarFirma(sha1)).toEqual({
      valida: false,
      motivo: 'Las referencias deben usar SHA-256 (xmlenc#sha256)',
    });
  });

  it('rechaza DOCTYPE al firmar y al verificar', () => {
    const conDoctype = `<!DOCTYPE Invoice [<!ENTITY x "y">]>${INVOICE}`;
    expect(() => firmarXml(conDoctype, { p12, password: PASSWORD })).toThrow(/DOCTYPE/);
    expect(verificarFirma(`<!DOCTYPE Invoice>${firmado}`)).toMatchObject({
      valida: false,
      motivo: expect.stringMatching(/DOCTYPE/),
    });
  });

  it('rechaza un XML de más de 5 MB', () => {
    const enorme = INVOICE.replace('Nota', 'x'.repeat(5 * 1024 * 1024));
    expect(() => firmarXml(enorme, { p12, password: PASSWORD })).toThrow(/5 MB/);
    expect(verificarFirma(enorme)).toMatchObject({ valida: false, motivo: expect.stringMatching(/5 MB/) });
  });

  it('rechaza atributos con tab o salto de línea, escritos tal cual o como referencia', () => {
    const cert = { p12, password: PASSWORD };
    expect(() => firmarXml(INVOICE.replace('currencyID="COP"', 'currencyID="CO\tP"'), cert)).toThrow(
      /currencyID trae tab/,
    );
    expect(() => firmarXml(INVOICE.replace('currencyID="COP"', 'currencyID="CO&#10;P"'), cert)).toThrow(
      /currencyID trae tab/,
    );
    // En el texto de un elemento sí se admiten.
    const enTexto = firmarXml(INVOICE.replace('Nota', 'Nota\n\tcon tab'), cert);
    expect(verificarFirma(enTexto)).toEqual({ valida: true });
  });
});

type Nodo = forge.asn1.Asn1;
const A = forge.asn1;
const hijos = (n: Nodo | undefined): Nodo[] => (n?.value ?? []) as Nodo[];
const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';

/**
 * Mete en un EncryptedData (cifrado con `password`, 2 048 iteraciones) el
 * SafeContents que trae la llave cifrada. Así la llave queda ANIDADA: sus
 * iteraciones solo se ven después de descifrar el contenedor. Sale sin MAC;
 * `conMac` se lo pone.
 */
function conLlaveEnEncryptedData(p12Der: Buffer, password: string): Buffer {
  const pfx = A.fromDer(forge.util.createBuffer(p12Der.toString('binary')));
  const octeto = hijos(hijos(hijos(pfx)[1])[1])[0]!;
  const infos = hijos(A.fromDer(octeto.value as string)).map((info) => {
    const [tipo, envoltura] = hijos(info);
    if (A.derToOid(tipo!.value as string) !== OID_DATA) return info;
    const safe = A.fromDer(hijos(envoltura)[0]!.value as string);
    const bagId = A.derToOid(hijos(hijos(safe)[0])[0]!.value as string);
    if (bagId !== forge.pki.oids.pkcs8ShroudedKeyBag) return info;
    const epki = forge.pki.encryptPrivateKeyInfo(safe, password, { algorithm: '3des', count: 2048 });
    return A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
      A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(OID_ENCRYPTED_DATA).getBytes()),
      A.create(A.Class.CONTEXT_SPECIFIC, 0, true, [
        A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
          A.create(A.Class.UNIVERSAL, A.Type.INTEGER, false, A.integerToDer(0).getBytes()),
          A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
            A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(OID_DATA).getBytes()),
            hijos(epki)[0]!,
            A.create(A.Class.CONTEXT_SPECIFIC, 0, false, hijos(epki)[1]!.value as string),
          ]),
        ]),
      ]),
    ]);
  });
  octeto.value = A.toDer(A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, infos)).getBytes();
  pfx.value = hijos(pfx).slice(0, 2);
  return Buffer.from(A.toDer(pfx).getBytes(), 'binary');
}

/** `p12_ilegible` con el mensaje fijo, sin `cause`, en menos de `ms`. */
function exigirIlegibleRapido(der: Buffer, ms = 500): void {
  const t0 = performance.now();
  let error: unknown;
  try {
    abrirP12(der, PASSWORD);
  } catch (e) {
    error = e;
  }
  expect(performance.now() - t0).toBeLessThan(ms);
  expect(error).toBeInstanceOf(ErrorFirma);
  expect((error as ErrorFirma).codigo).toBe('p12_ilegible');
  expect((error as ErrorFirma).message).toMatch(/no es un .p12 válido/);
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
}

/**
 * La revisión del .p12 es `prepararP12` (domain/certificado-p12.ts, #95); sus
 * casos están en certificado-p12.spec.ts. Aquí se comprueba que la firma la usa
 * y que hacia afuera todo rechazo es `p12_ilegible`.
 */
describe('abrirP12 usa la revisión del #95 (DoS)', () => {
  it('abre un .p12 normal, también con la llave dentro de un EncryptedData', () => {
    expect(abrirP12(p12, PASSWORD).cadena).toHaveLength(1);
    const anidado = conMac(conLlaveEnEncryptedData(p12, PASSWORD), PASSWORD);
    expect(abrirP12(anidado, PASSWORD).cadena).toHaveLength(1);
  });

  it('MAC con iteraciones enormes: p12_ilegible enseguida', () => {
    exigirIlegibleRapido(conIteracionesMac(p12, ITERACIONES_ENORMES));
  });

  it('llave con iteraciones enormes en claro: p12_ilegible enseguida', () => {
    exigirIlegibleRapido(conMac(conIteracionesLlave(p12, ITERACIONES_ENORMES), PASSWORD));
  });

  it('llave con iteraciones enormes ANIDADA en un EncryptedData: p12_ilegible enseguida', () => {
    const anidado = conMac(
      conLlaveEnEncryptedData(conIteracionesLlave(p12, ITERACIONES_ENORMES), PASSWORD),
      PASSWORD,
    );
    exigirIlegibleRapido(anidado);
  });

  it('más de 10 certificados, más de 64 KB o basura: p12_ilegible', () => {
    const muchos = Array.from({ length: MAX_CERT_BAGS_P12 + 1 }, () => firmante);
    const der = Buffer.from(
      forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(llave, muchos, PASSWORD, { algorithm: '3des' })).getBytes(),
      'binary',
    );
    exigirIlegibleRapido(der);
    exigirIlegibleRapido(Buffer.alloc(MAX_BYTES_P12_FIRMA + 1));
    exigirIlegibleRapido(Buffer.from('no soy asn1'));
  });
});
