import { describe, expect, it } from 'vitest';
import { POLITICA_FIRMA_DIAN } from './firma.constants';
import {
  armarQualifyingProperties,
  extensionDeFirma,
  idsFirma,
  nombreRfc4514,
  signingTimeColombia,
} from './propiedades-firmadas';

describe('idsFirma', () => {
  it('sigue el patrón xmldsig-{uuid}-… del anexo de nómina §7.9', () => {
    expect(idsFirma('50280329-CDF3-4bb7-9d8f-edd480c8079c')).toEqual({
      firma: 'xmldsig-50280329-cdf3-4bb7-9d8f-edd480c8079c',
      referenciaDocumento: 'xmldsig-50280329-cdf3-4bb7-9d8f-edd480c8079c-ref0',
      keyInfo: 'xmldsig-50280329-cdf3-4bb7-9d8f-edd480c8079c-keyinfo',
      signedProperties: 'xmldsig-50280329-cdf3-4bb7-9d8f-edd480c8079c-signedprops',
      signatureValue: 'xmldsig-50280329-cdf3-4bb7-9d8f-edd480c8079c-sigvalue',
    });
  });

  it('rechaza lo que no es un UUID (iría sin escapar a un atributo)', () => {
    expect(() => idsFirma('x" onload="')).toThrow();
  });
});

describe('signingTimeColombia', () => {
  it('convierte el instante UTC a -05:00, también cruzando la medianoche', () => {
    expect(signingTimeColombia(new Date('2026-10-30T14:15:07Z'))).toBe('2026-10-30T09:15:07-05:00');
    expect(signingTimeColombia(new Date('2026-01-01T03:00:00Z'))).toBe('2025-12-31T22:00:00-05:00');
  });

  it('rechaza una fecha inválida', () => {
    expect(() => signingTimeColombia(new Date('no'))).toThrow();
  });
});

describe('nombreRfc4514', () => {
  it('invierte el orden y escapa los caracteres especiales', () => {
    expect(
      nombreRfc4514([
        { tipo: 'C', valor: 'CO' },
        { tipo: 'O', valor: 'Andes SCD, S.A.' },
        { tipo: 'CN', valor: '#Sub CA ' },
      ]),
    ).toBe('CN=\\#Sub CA\\ ,O=Andes SCD\\, S.A.,C=CO');
  });
});

describe('armarQualifyingProperties', () => {
  const ids = idsFirma('50280329-cdf3-4bb7-9d8f-edd480c8079c');
  const cert = { resumenB64: 'AAAA', emisor: 'CN=A & B', serialDecimal: '9128602840918470673' };

  it('arma SignedProperties con política DIAN v2, rol y cadena, sin espacios', () => {
    const xml = armarQualifyingProperties({ ids, signingTime: '2026-10-30T09:15:00-05:00', cadena: [cert, cert] });
    expect(xml).toContain(`Target="#${ids.firma}"`);
    expect(xml).toContain(`<xades:SignedProperties Id="${ids.signedProperties}">`);
    expect(xml).toContain('<xades:SigningTime>2026-10-30T09:15:00-05:00</xades:SigningTime>');
    expect(xml.match(/<xades:Cert>/g)).toHaveLength(2);
    expect(xml).toContain('<ds:X509IssuerName>CN=A &amp; B</ds:X509IssuerName>');
    expect(xml).toContain(`<xades:Identifier>${POLITICA_FIRMA_DIAN.identificador}</xades:Identifier>`);
    expect(xml).toContain(`<ds:DigestValue>${POLITICA_FIRMA_DIAN.resumen}</ds:DigestValue>`);
    expect(xml).toContain('<xades:ClaimedRole>supplier</xades:ClaimedRole>');
    expect(xml).not.toMatch(/>\s+</);
  });

  it('acepta third party y exige una cadena válida', () => {
    expect(armarQualifyingProperties({ ids, signingTime: 't', cadena: [cert], rol: 'third party' })).toContain(
      '<xades:ClaimedRole>third party</xades:ClaimedRole>',
    );
    expect(() => armarQualifyingProperties({ ids, signingTime: 't', cadena: [] })).toThrow();
    expect(() =>
      armarQualifyingProperties({ ids, signingTime: 't', cadena: [{ ...cert, serialDecimal: '0x1' }] }),
    ).toThrow();
  });
});

describe('extensionDeFirma', () => {
  it('la segunda si hay dos o más; la única si hay una', () => {
    expect(extensionDeFirma(2)).toBe(2);
    expect(extensionDeFirma(3)).toBe(2);
    expect(extensionDeFirma(1)).toBe(1);
    expect(() => extensionDeFirma(0)).toThrow();
  });
});
