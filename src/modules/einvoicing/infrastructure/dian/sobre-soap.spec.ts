import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { p12DePrueba } from '../../domain/p12-de-prueba.test';
import { abrirP12, type MaterialFirma } from '../firma/material-p12';
import {
  ALG_EXC_C14N,
  ALG_RSA_SHA256,
  ALG_SHA256,
  NS_DS_WSS,
  NS_SOAP12,
  NS_WCF,
  NS_WSA,
  NS_WSSE,
  NS_WSU,
  URL_DIAN_POR_AMBIENTE,
  VALUE_TYPE_X509,
} from './dian.constants';
import { contentTypeSoap, cuerpoOperacion, sobreFirmado } from './sobre-soap';

let material: MaterialFirma;
const URL_HAB = URL_DIAN_POR_AMBIENTE['2'];
const AHORA = new Date('2026-10-30T15:00:00.000Z');

beforeAll(() => {
  material = abrirP12(p12DePrueba(), 'clave-de-prueba');
});

function parsear(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

function pemDeB64(b64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
}

/** Verifica la firma con el certificado del propio BinarySecurityToken. */
function verificar(xml: string): { valida: boolean; uris: string[]; firma: Element } {
  const doc = parsear(xml);
  const firma = doc.getElementsByTagNameNS(NS_DS_WSS, 'Signature')[0]!;
  const token = doc.getElementsByTagNameNS(NS_WSSE, 'BinarySecurityToken')[0]!;
  const v = new SignedXml({ publicCert: pemDeB64(token.textContent!), idMode: 'wssecurity' });
  v.loadSignature(firma as unknown as Node);
  const valida = v.checkSignature(xml);
  const uris = Array.from(firma.getElementsByTagNameNS(NS_DS_WSS, 'Reference')).map((r) => r.getAttribute('URI')!);
  return { valida, uris, firma };
}

function idDe(doc: Document, ns: string, local: string): string {
  return doc.getElementsByTagNameNS(ns, local)[0]!.getAttributeNS(NS_WSU, 'Id')!;
}

describe('sobre SOAP con WS-Security', () => {
  it('firma To, Action y Timestamp con RSA-SHA256, SHA-256 y exc-c14n, verificable con el token', () => {
    const xml = sobreFirmado('GetStatus', URL_HAB, [['trackId', 'cufe-1']], material, { ahora: AHORA, uuid: 'u1' });
    const { valida, uris, firma } = verificar(xml);
    expect(valida).toBe(true);
    const doc = parsear(xml);
    expect(uris.slice(0, 3).sort()).toEqual(
      [`#${idDe(doc, NS_WSA, 'Action')}`, `#${idDe(doc, NS_WSA, 'To')}`, `#${idDe(doc, NS_WSU, 'Timestamp')}`].sort(),
    );
    expect(firma.getElementsByTagNameNS(NS_DS_WSS, 'SignatureMethod')[0]!.getAttribute('Algorithm')).toBe(ALG_RSA_SHA256);
    expect(firma.getElementsByTagNameNS(NS_DS_WSS, 'CanonicalizationMethod')[0]!.getAttribute('Algorithm')).toBe(ALG_EXC_C14N);
    for (const d of Array.from(firma.getElementsByTagNameNS(NS_DS_WSS, 'DigestMethod'))) {
      expect(d.getAttribute('Algorithm')).toBe(ALG_SHA256);
    }
    // La firma vive dentro de wsse:Security y su KeyInfo apunta al token.
    expect((firma.parentNode as Element).localName).toBe('Security');
    const ref = firma.getElementsByTagNameNS(NS_WSSE, 'Reference')[0]!;
    expect(ref.getAttribute('URI')).toBe(`#${idDe(doc, NS_WSSE, 'BinarySecurityToken')}`);
    expect(ref.getAttribute('ValueType')).toBe(VALUE_TYPE_X509);
  });

  it('el token es el certificado del .p12 y la llave privada no viaja', () => {
    const xml = sobreFirmado('GetStatus', URL_HAB, [['trackId', 'x']], material, { ahora: AHORA });
    const doc = parsear(xml);
    expect(doc.getElementsByTagNameNS(NS_WSSE, 'BinarySecurityToken')[0]!.textContent).toBe(material.certificadoB64);
    expect(xml).not.toContain('PRIVATE KEY');
    const cuerpoLlave = material.llavePem.split('\n').slice(1, -2).join('');
    expect(xml).not.toContain(cuerpoLlave.slice(0, 40));
  });

  it('alterar el To o la Action rompe la firma', () => {
    const xml = sobreFirmado('SendBillSync', URL_HAB, [['fileName', 'z.zip'], ['contentFile', 'QUJD']], material, { ahora: AHORA });
    expect(verificar(xml).valida).toBe(true);
    expect(verificar(xml.replace(URL_HAB, URL_DIAN_POR_AMBIENTE['1'])).valida).toBe(false);
    expect(verificar(xml.replace('/SendBillSync<', '/GetStatus<')).valida).toBe(false);
  });

  it('alterar el Timestamp rompe la firma', () => {
    const xml = sobreFirmado('GetStatus', URL_HAB, [['trackId', 'x']], material, { ahora: AHORA });
    expect(verificar(xml.replace('2026-10-30T15:01:00.000Z', '2026-10-30T23:59:00.000Z')).valida).toBe(false);
  });

  it('las partes firmadas se pueden reducir (p. ej. solo To) si habilitación lo pide', () => {
    const xml = sobreFirmado('GetStatus', URL_HAB, [['trackId', 'x']], material, { ahora: AHORA, partes: ['To'] });
    const { valida, uris } = verificar(xml);
    expect(valida).toBe(true);
    expect(uris.filter((u) => u.startsWith('#id-'))).toEqual([`#${idDe(parsear(xml), NS_WSA, 'To')}`]);
    expect(uris).toHaveLength(1);
  });

  it('rechaza valores con caracteres que XML 1.0 no permite', () => {
    for (const malo of ['a\u0000b', 'a\u0008b', 'a￾b', 'a\uD800b']) {
      expect(() => cuerpoOperacion('GetStatus', [['trackId', malo]])).toThrow(/XML 1.0/);
    }
    expect(cuerpoOperacion('GetStatus', [['trackId', 'tab\tok ñ \u{1F600}']])).toContain('ñ \u{1F600}');
  });

  it('Timestamp de 60 s, Action por operación y To con la URL', () => {
    const xml = sobreFirmado('GetNumberingRange', URL_HAB, [['accountCode', '900123456']], material, { ahora: AHORA });
    const doc = parsear(xml);
    expect(doc.documentElement.namespaceURI).toBe(NS_SOAP12);
    expect(doc.getElementsByTagNameNS(NS_WSU, 'Created')[0]!.textContent).toBe('2026-10-30T15:00:00.000Z');
    expect(doc.getElementsByTagNameNS(NS_WSU, 'Expires')[0]!.textContent).toBe('2026-10-30T15:01:00.000Z');
    expect(doc.getElementsByTagNameNS(NS_WSA, 'Action')[0]!.textContent).toBe(
      'http://wcf.dian.colombia/IWcfDianCustomerServices/GetNumberingRange',
    );
    expect(doc.getElementsByTagNameNS(NS_WSA, 'To')[0]!.textContent).toBe(URL_HAB);
  });

  it('cuerpo por operación con sus parámetros en el namespace wcf', () => {
    const xml = sobreFirmado(
      'SendTestSetAsync',
      URL_HAB,
      [['fileName', 'z1.zip'], ['contentFile', 'QUJD'], ['testSetId', 'set-<1>']],
      material,
      { ahora: AHORA },
    );
    const doc = parsear(xml);
    const op = doc.getElementsByTagNameNS(NS_WCF, 'SendTestSetAsync')[0]!;
    const hijos = Array.from(op.childNodes).filter((n) => n.nodeType === 1) as Element[];
    expect(hijos.map((h) => [h.localName, h.textContent])).toEqual([
      ['fileName', 'z1.zip'],
      ['contentFile', 'QUJD'],
      ['testSetId', 'set-<1>'],
    ]);
    expect(cuerpoOperacion('GetStatusZip', [['trackId', 'a&b']])).toBe(
      '<wcf:GetStatusZip><wcf:trackId>a&amp;b</wcf:trackId></wcf:GetStatusZip>',
    );
    expect(() => cuerpoOperacion('GetStatus', [['mal nombre', 'x']])).toThrow();
  });

  it('Content-Type SOAP 1.2 con la acción', () => {
    expect(contentTypeSoap('SendBillSync')).toBe(
      'application/soap+xml;charset=utf-8;action="http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync"',
    );
  });

  it('rechaza un certificado que no es base64', () => {
    expect(() =>
      sobreFirmado('GetStatus', URL_HAB, [], { llavePem: material.llavePem, certificadoB64: '<x/>' }),
    ).toThrow();
  });
});
