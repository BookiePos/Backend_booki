import { generateKeyPairSync, X509Certificate } from 'crypto';
import * as forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALG_C14N, ALG_RESUMEN_SHA256 } from '../../domain/firma/firma.constants';
import { firmarXml, verificarFirma } from './firma-xades';
import { LIMITES_P12, P12FueraDeLimites, revisarLimitesP12 } from './limites-p12';
import { abrirP12, ErrorFirma } from './material-p12';

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
const hijos = (n: Nodo | undefined): Nodo[] => (n?.value ?? []) as Nodo[];

/** Reescribe las iteraciones del MAC y/o de la bolsa de la llave (PBE de PKCS#12). */
function conIteraciones(der: Buffer, opciones: { mac?: number; llave?: number; oidLlave?: string }): Buffer {
  const { asn1 } = forge;
  const entero = (n: number): Nodo =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());
  const pfx = asn1.fromDer(forge.util.createBuffer(der.toString('binary')));
  const [, authSafe, macData] = hijos(pfx);
  if (opciones.mac !== undefined) hijos(macData)[2] = entero(opciones.mac);
  if (opciones.llave !== undefined || opciones.oidLlave !== undefined) {
    const octetoAuth = hijos(hijos(authSafe)[1])[0]!;
    const auth = asn1.fromDer(octetoAuth.value as string);
    for (const info of hijos(auth)) {
      const [tipo, envoltura] = hijos(info);
      if (asn1.derToOid(tipo!.value as string) !== '1.2.840.113549.1.7.1') continue;
      const octeto = hijos(envoltura)[0]!;
      const bolsas = asn1.fromDer(octeto.value as string);
      for (const bolsa of hijos(bolsas)) {
        const [bagId, valor] = hijos(bolsa);
        if (asn1.derToOid(bagId!.value as string) !== forge.pki.oids.pkcs8ShroudedKeyBag) continue;
        const algoritmo = hijos(hijos(valor)[0])[0];
        if (opciones.llave !== undefined) hijos(hijos(algoritmo)[1])[1] = entero(opciones.llave);
        if (opciones.oidLlave !== undefined) {
          hijos(algoritmo)[0] = asn1.create(
            asn1.Class.UNIVERSAL,
            asn1.Type.OID,
            false,
            asn1.oidToDer(opciones.oidLlave).getBytes(),
          );
        }
      }
      octeto.value = asn1.toDer(bolsas).getBytes();
    }
    octetoAuth.value = asn1.toDer(auth).getBytes();
  }
  return Buffer.from(asn1.toDer(pfx).getBytes(), 'binary');
}

describe('revisarLimitesP12 (DoS)', () => {
  it('deja pasar un .p12 normal', () => {
    expect(() => revisarLimitesP12(p12)).not.toThrow();
  });

  it('corta sin descifrar un MAC con iteraciones enormes', () => {
    const malo = conIteraciones(p12, { mac: 2_000_000_000 });
    const t0 = performance.now();
    expect(() => revisarLimitesP12(malo)).toThrow(P12FueraDeLimites);
    expect(() => abrirP12(malo, PASSWORD)).toThrow(ErrorFirma);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('corta sin descifrar una llave cifrada con iteraciones enormes', () => {
    const malo = conIteraciones(p12, { llave: 2_000_000_000 });
    let error: unknown;
    try {
      revisarLimitesP12(malo);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(P12FueraDeLimites);
    expect((error as P12FueraDeLimites).motivo).toBe('iteraciones');
    const t0 = performance.now();
    expect(() => abrirP12(malo, PASSWORD)).toThrow(/no es un .p12 válido/);
    expect(performance.now() - t0).toBeLessThan(500);
    // Justo en el límite sí pasa la revisión (no se descifra aquí).
    expect(() => revisarLimitesP12(conIteraciones(p12, { llave: LIMITES_P12.iteraciones }))).not.toThrow();
  });

  it('rechaza un algoritmo de cifrado de llave que no sabe acotar', () => {
    const raro = conIteraciones(p12, { oidLlave: '1.3.6.1.4.1.99999.1' });
    expect(() => revisarLimitesP12(raro)).toThrow(/estructura/);
    expect(() => abrirP12(raro, PASSWORD)).toThrow(/no es un .p12 válido/);
  });

  it('rechaza más de 10 certificados, archivos de más de 64 KB y basura', () => {
    const muchos = Array.from({ length: LIMITES_P12.bolsasCertificado + 1 }, () => firmante);
    const der = Buffer.from(
      forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(llave, muchos, PASSWORD, { algorithm: '3des' })).getBytes(),
      'binary',
    );
    expect(() => revisarLimitesP12(der)).toThrow(/certificados/);
    expect(() => abrirP12(der, PASSWORD)).toThrow(ErrorFirma);
    expect(() => revisarLimitesP12(Buffer.alloc(LIMITES_P12.bytes + 1))).toThrow(/tamano/);
    expect(() => revisarLimitesP12(Buffer.from('no soy asn1'))).toThrow(/estructura/);
  });
});
