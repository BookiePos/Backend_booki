import { createHash, generateKeyPairSync, X509Certificate } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import * as forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALG_C14N,
  ALG_ENVELOPED,
  ALG_FIRMA_RSA_SHA256,
  ALG_RESUMEN_SHA256,
  NS_DS,
  NS_XADES,
  POLITICA_FIRMA_DIAN,
} from '../../domain/firma/firma.constants';
import { firmarXml, verificarFirma } from './firma-xades';
import { abrirP12, ErrorFirma } from './material-p12';

/**
 * .p12 de prueba armado aquí mismo (raíz → intermedia → firmante), nunca un
 * certificado real. Las llaves salen de `crypto` (RSA en JS puro tarda segundos);
 * los certificados y el PKCS#12, de node-forge.
 */
const PASSWORD = 'clave-de-prueba';

function llaves(): { privada: forge.pki.rsa.PrivateKey; publica: forge.pki.rsa.PublicKey } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privada: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()),
    publica: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  };
}

function certificado(
  serial: string,
  sujeto: forge.pki.CertificateField[],
  publica: forge.pki.rsa.PublicKey,
  emisor: { atributos: forge.pki.CertificateField[]; privada: forge.pki.rsa.PrivateKey },
  esCa: boolean,
): forge.pki.Certificate {
  const c = forge.pki.createCertificate();
  c.serialNumber = serial;
  c.publicKey = publica;
  c.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  c.validity.notAfter = new Date('2028-01-01T00:00:00Z');
  c.setSubject(sujeto);
  c.setIssuer(emisor.atributos);
  c.setExtensions(
    esCa
      ? [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]
      : [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true }],
  );
  c.sign(emisor.privada, forge.md.sha256.create());
  return c;
}

interface P12DePrueba {
  p12: Buffer;
  firmante: forge.pki.Certificate;
  cadena: forge.pki.Certificate[];
}

function p12DePrueba(): P12DePrueba {
  const raiz = llaves();
  const inter = llaves();
  const hoja = llaves();
  const nRaiz = [{ name: 'commonName', value: 'Raiz de Prueba BookiPos' }, { name: 'countryName', value: 'CO' }];
  const nInter = [{ name: 'commonName', value: 'Sub CA de Prueba, BookiPos' }, { name: 'organizationName', value: 'BookiPos' }];
  const nHoja = [{ name: 'commonName', value: 'Emisor de Prueba SAS' }, { name: 'serialNumber', value: '900123456' }];
  const cRaiz = certificado('01', nRaiz, raiz.publica, { atributos: nRaiz, privada: raiz.privada }, true);
  const cInter = certificado('0a1b', nInter, inter.publica, { atributos: nRaiz, privada: raiz.privada }, true);
  const cHoja = certificado('7eaf4feb1c91', nHoja, hoja.publica, { atributos: nInter, privada: inter.privada }, false);
  // Orden revuelto a propósito: abrirP12 debe reconstruir la cadena.
  const asn1 = forge.pkcs12.toPkcs12Asn1(hoja.privada, [cRaiz, cHoja, cInter], PASSWORD, { algorithm: '3des' });
  return {
    p12: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'),
    firmante: cHoja,
    cadena: [cHoja, cInter, cRaiz],
  };
}

/** Invoice UBL mínimo con las dos extensiones: DianExtensions y la ranura de la firma. */
const INVOICE =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
  '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
  ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
  ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
  ' xmlns:ds="http://www.w3.org/2000/09/xmldsig#"' +
  ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"' +
  ' xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"' +
  ' xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"' +
  ' xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#">' +
  '<ext:UBLExtensions>' +
  '<ext:UBLExtension><ext:ExtensionContent><sts:DianExtensions>' +
  '<sts:InvoiceControl><sts:InvoiceAuthorization>18760000001</sts:InvoiceAuthorization></sts:InvoiceControl>' +
  '</sts:DianExtensions></ext:ExtensionContent></ext:UBLExtension>' +
  '<ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension>' +
  '</ext:UBLExtensions>' +
  '<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>' +
  '<cbc:ID>SETP990000001</cbc:ID>' +
  '<cbc:IssueDate>2026-10-30</cbc:IssueDate>' +
  '<cbc:IssueTime>09:15:00-05:00</cbc:IssueTime>' +
  '<cbc:Note>Café &amp; pan</cbc:Note>' +
  '<cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="COP">11900.00</cbc:PayableAmount></cac:LegalMonetaryTotal>' +
  '</Invoice>';

/** Nómina: una sola extensión y otro elemento raíz. */
const NOMINA =
  '<NominaIndividual xmlns="dian:gov:co:facturaelectronica:NominaIndividual"' +
  ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">' +
  '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>' +
  '<Periodo FechaIngreso="2026-01-01" FechaLiquidacionInicio="2026-10-01" FechaLiquidacionFin="2026-10-30"/>' +
  '</NominaIndividual>';

const AHORA = new Date('2026-10-30T14:15:00Z');
const UUID = '50280329-cdf3-4bb7-9d8f-edd480c8079c';

let prueba: P12DePrueba;
let firmado: string;
let msFirma: number;

const parsear = (xml: string): Document =>
  new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
const uno = (doc: Document | Element, ns: string, nombre: string): Element =>
  doc.getElementsByTagNameNS(ns, nombre)[0] as Element;

beforeAll(() => {
  prueba = p12DePrueba();
  const t0 = performance.now();
  firmado = firmarXml(INVOICE, { p12: prueba.p12, password: PASSWORD }, { ahora: AHORA, uuid: UUID });
  msFirma = performance.now() - t0;
  // Presupuesto para Vercel serverless: firmar (abrir el .p12 incluido) en el test.
  console.info(`[firma-xades] firmar un Invoice mínimo tardó ${msFirma.toFixed(1)} ms`);
});

describe('firmarXml + verificarFirma', () => {
  it('firma un Invoice y la verificación pasa', () => {
    expect(verificarFirma(firmado)).toEqual({ valida: true });
  });

  it('la firma queda en la SEGUNDA ext:UBLExtension', () => {
    const doc = parsear(firmado);
    const extensiones = doc.getElementsByTagNameNS(
      'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
      'UBLExtension',
    );
    expect(extensiones.length).toBe(2);
    expect(extensiones[0]!.getElementsByTagNameNS(NS_DS, 'Signature').length).toBe(0);
    const firma = uno(extensiones[1]!, NS_DS, 'Signature');
    expect((firma.parentNode as Element | null)?.localName).toBe('ExtensionContent');
    expect(firma.prefix).toBe('ds');
    expect(firma.getAttribute('Id')).toBe(`xmldsig-${UUID}`);
  });

  it('SignedInfo: C14N 1.0, RSA-SHA256 y las tres referencias SHA-256 con sus ids', () => {
    const doc = parsear(firmado);
    expect(uno(doc, NS_DS, 'CanonicalizationMethod').getAttribute('Algorithm')).toBe(ALG_C14N);
    expect(uno(doc, NS_DS, 'SignatureMethod').getAttribute('Algorithm')).toBe(ALG_FIRMA_RSA_SHA256);
    const refs = Array.from(uno(doc, NS_DS, 'SignedInfo').getElementsByTagNameNS(NS_DS, 'Reference'));
    expect(refs.map((r) => r.getAttribute('URI'))).toEqual([
      '',
      `#xmldsig-${UUID}-keyinfo`,
      `#xmldsig-${UUID}-signedprops`,
    ]);
    expect(refs[0]!.getAttribute('Id')).toBe(`xmldsig-${UUID}-ref0`);
    expect(refs[2]!.getAttribute('Type')).toBe('http://uri.etsi.org/01903#SignedProperties');
    expect(
      Array.from(refs[0]!.getElementsByTagNameNS(NS_DS, 'Transform')).map((t) => t.getAttribute('Algorithm')),
    ).toEqual([ALG_ENVELOPED]);
    for (const r of refs) {
      expect(uno(r, NS_DS, 'DigestMethod').getAttribute('Algorithm')).toBe(ALG_RESUMEN_SHA256);
    }
    // Referencias 2 y 3 con C14N 1.0 explícito (equivale a no declarar transformadas).
    for (const r of [refs[1]!, refs[2]!]) {
      expect(
        Array.from(r.getElementsByTagNameNS(NS_DS, 'Transform')).map((t) => t.getAttribute('Algorithm')),
      ).toEqual([ALG_C14N]);
    }
    expect(uno(doc, NS_DS, 'SignatureValue').getAttribute('Id')).toBe(`xmldsig-${UUID}-sigvalue`);
  });

  it('KeyInfo trae el certificado del firmante', () => {
    const doc = parsear(firmado);
    const b64 = uno(uno(doc, NS_DS, 'KeyInfo'), NS_DS, 'X509Certificate').textContent ?? '';
    const cert = new X509Certificate(Buffer.from(b64, 'base64'));
    expect(cert.subject).toContain('Emisor de Prueba SAS');
  });

  it('SigningTime en hora colombiana con -05:00', () => {
    const doc = parsear(firmado);
    expect(uno(doc, NS_XADES, 'SigningTime').textContent).toBe('2026-10-30T09:15:00-05:00');
  });

  it('SigningCertificate lleva la cadena completa: resumen, emisor y serial de cada certificado', () => {
    const certs = Array.from(parsear(firmado).getElementsByTagNameNS(NS_XADES, 'Cert'));
    expect(certs).toHaveLength(3);
    certs.forEach((nodo, i) => {
      const c = prueba.cadena[i]!;
      const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes(), 'binary');
      expect(uno(nodo, NS_DS, 'DigestValue').textContent).toBe(createHash('sha256').update(der).digest('base64'));
      expect(uno(nodo, NS_DS, 'X509SerialNumber').textContent).toBe(BigInt(`0x${c.serialNumber}`).toString());
    });
    const emisores = certs.map((n) => uno(n, NS_DS, 'X509IssuerName').textContent);
    expect(emisores).toEqual([
      'O=BookiPos,CN=Sub CA de Prueba\\, BookiPos',
      'C=CO,CN=Raiz de Prueba BookiPos',
      'C=CO,CN=Raiz de Prueba BookiPos',
    ]);
  });

  it('política DIAN v2 y ClaimedRole supplier', () => {
    const doc = parsear(firmado);
    expect(uno(doc, NS_XADES, 'Identifier').textContent).toBe(
      'https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf',
    );
    const hash = uno(doc, NS_XADES, 'SigPolicyHash');
    expect(uno(hash, NS_DS, 'DigestMethod').getAttribute('Algorithm')).toBe(ALG_RESUMEN_SHA256);
    expect(uno(hash, NS_DS, 'DigestValue').textContent).toBe(POLITICA_FIRMA_DIAN.resumen);
    expect(uno(doc, NS_XADES, 'ClaimedRole').textContent).toBe('supplier');
  });

  it('la constante del hash de la política es la del PDF oficial (SHA-256, base64)', () => {
    // Calculado sobre politicadefirmav2.pdf descargado de facturaelectronica.dian.gov.co
    // el 2026-10-30; es el mismo valor que aceptan las firmas validadas por la DIAN.
    expect(POLITICA_FIRMA_DIAN.resumen).toBe('dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y=');
    expect(Buffer.from(POLITICA_FIRMA_DIAN.resumen, 'base64')).toHaveLength(32);
  });

  it('alterar un byte del documento invalida la firma', () => {
    const alterado = firmado.replace('11900.00', '11900.01');
    expect(alterado).not.toBe(firmado);
    expect(verificarFirma(alterado).valida).toBe(false);
  });

  it('alterar SignedProperties invalida la firma', () => {
    const alterado = firmado.replace('2026-10-30T09:15:00-05:00', '2026-10-30T09:15:01-05:00');
    expect(alterado).not.toBe(firmado);
    expect(verificarFirma(alterado).valida).toBe(false);
  });

  it('alterar KeyInfo invalida la firma', () => {
    const alterado = firmado.replace(`Id="xmldsig-${UUID}-keyinfo"`, `Id="xmldsig-${UUID}-keyinfo" xml:lang="es"`);
    expect(verificarFirma(alterado).valida).toBe(false);
  });

  it('quitar la declaración XML no cambia el resumen del documento', () => {
    const sinDeclaracion = firmado.replace(/^<\?xml[^>]*\?>/, '');
    expect(sinDeclaracion).not.toBe(firmado);
    expect(verificarFirma(sinDeclaracion)).toEqual({ valida: true });
  });

  it('una firma movida a la primera extensión no verifica', () => {
    const doc = parsear(firmado);
    const firma = uno(doc, NS_DS, 'Signature');
    const exts = doc.getElementsByTagNameNS(
      'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
      'ExtensionContent',
    );
    exts[0]!.appendChild(firma);
    const movido = doc.toString();
    expect(verificarFirma(movido)).toMatchObject({ valida: false });
  });

  it('el mismo perfil firma otro elemento raíz (nómina, una sola extensión)', () => {
    const xml = firmarXml(NOMINA, { p12: prueba.p12, password: PASSWORD }, { ahora: AHORA });
    expect(verificarFirma(xml)).toEqual({ valida: true });
    expect(parsear(xml).documentElement.localName).toBe('NominaIndividual');
  });

  it('rechaza un documento sin ranura vacía o ya firmado', () => {
    const cert = { p12: prueba.p12, password: PASSWORD };
    expect(() => firmarXml(firmado, cert)).toThrow(ErrorFirma);
    const sinExtension = INVOICE.replace(/<ext:UBLExtensions>.*<\/ext:UBLExtensions>/, '');
    expect(() => firmarXml(sinExtension, cert)).toThrow(/UBLExtension/);
    expect(() => firmarXml('<Invoice', cert)).toThrow(/bien formado/);
  });

  it('firma en menos de 1,5 s (presupuesto de Vercel serverless)', () => {
    expect(msFirma).toBeLessThan(1500);
  });
});

describe('abrirP12', () => {
  it('reconstruye la cadena firmante → intermedia → raíz', () => {
    const m = abrirP12(prueba.p12, PASSWORD);
    expect(m.cadena).toHaveLength(3);
    expect(m.llavePem).toContain('PRIVATE KEY');
  });

  it('con la contraseña equivocada falla sin revelarla', () => {
    const malo = 'contraseña-que-no-es-9f3a';
    let error: unknown;
    try {
      abrirP12(prueba.p12, malo);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ErrorFirma);
    const err = error as ErrorFirma;
    expect(err.codigo).toBe('p12_ilegible');
    expect(`${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`).not.toContain(malo);
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('un archivo que no es .p12 falla con el mismo mensaje fijo', () => {
    expect(() => abrirP12(Buffer.from('no soy un p12'), PASSWORD)).toThrow(/no es un .p12 válido/);
  });
});
