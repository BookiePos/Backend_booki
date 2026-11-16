import { createHash } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { NS_DS } from '../../domain/firma/firma.constants';
import { p12DePrueba } from '../../domain/p12-de-prueba.test';
import { documento, EMISOR_FISCAL, linea, PIN, SOFTWARE_ID } from '../../domain/ubl/__fixtures__/factura-de-prueba.test';
import { prepararFacturaUbl } from '../../domain/ubl/factura-de-documento';
import { armarFacturaUbl, codigoSeguridadSoftware } from '../../domain/ubl/factura-ubl';
import { firmarXml, verificarFirma } from './firma-xades';
import { ErrorFirma } from './material-p12';

/**
 * Fase 11 · firma XAdES sobre una factura REAL del builder (no un XML mínimo):
 * qué cambia la firma en el documento y qué manipulaciones detecta el
 * verificador. Todos los specs de los builders se apoyan en `verificarFirma`;
 * si aceptara de más, su verde no diría nada.
 */
const PASSWORD = 'clave-de-prueba';
const CERT = { p12: p12DePrueba(), password: PASSWORD };
/** Certificado de otro titular (otro NIT en el sujeto). */
const OTRO = { p12: p12DePrueba({ nit: '800999999' }), password: PASSWORD };

const DOC = documento({
  lines: [
    linea({ name: `Camisa "L" & 'niño' <oferta>`, precio: 119_000, impuesto: 19_000, rate: 19 }),
    linea({ name: 'Bandeja', precio: 32_400, impuesto: 2_400, kind: 'inc', rate: 8 }),
  ],
  total: 151_400,
});
const f = prepararFacturaUbl(DOC, EMISOR_FISCAL);
const SIN_FIRMA = armarFacturaUbl({ ...f, codigoSeguridadSoftware: codigoSeguridadSoftware(SOFTWARE_ID, PIN, DOC.fullNumber) });
const FIRMADO = firmarXml(SIN_FIRMA, CERT, { ahora: new Date('2026-10-30T15:15:00Z'), uuid: '11111111-2222-3333-4444-555555555555' });

const BLOQUE_FIRMA = /<ds:Signature[\s\S]*<\/ds:Signature>/;

describe('firmarXml sobre una factura del builder', () => {
  it('solo añade la ds:Signature: el resto del documento queda byte a byte igual', () => {
    expect(verificarFirma(FIRMADO)).toEqual({ valida: true });
    expect(FIRMADO.match(BLOQUE_FIRMA)).not.toBeNull();
    // Ni un monto, ni el CUFE, ni un texto con comillas o «&» cambian al firmar: lo que entró al
    // CUFE es lo que viaja. Solo se pierde el salto de línea final del archivo.
    expect(FIRMADO.replace(BLOQUE_FIRMA, '')).toBe(SIN_FIRMA.trimEnd());
    expect(SIN_FIRMA).toContain(`Camisa "L" &amp; 'niño' &lt;oferta&gt;`);
    expect(FIRMADO).toContain(DOC.cufe!);
  });

  it('no deja la llave privada ni la contraseña del .p12 en el XML', () => {
    expect(FIRMADO).not.toContain('PRIVATE KEY');
    expect(FIRMADO).not.toContain(PASSWORD);
    expect(FIRMADO).not.toContain(PIN);
  });

  it('firmar dos veces el mismo documento no se permite (una sola firma por documento)', () => {
    expect(() => firmarXml(FIRMADO, CERT)).toThrow(ErrorFirma);
  });
});

describe('verificarFirma detecta la manipulación de una factura firmada', () => {
  const invalida = (xml: string, motivo?: RegExp): void => {
    const r = verificarFirma(xml);
    expect(r.valida).toBe(false);
    if (motivo) expect(r.motivo).toMatch(motivo);
  };

  it.each([
    ['el total a pagar', '<cbc:PayableAmount currencyID="COP">151400.00', '<cbc:PayableAmount currencyID="COP">151300.00'],
    ['el impuesto de una línea', '>19000.00<', '>18000.00<'],
    ['el CUFE', DOC.cufe!, `${DOC.cufe!.slice(0, 95)}${DOC.cufe!.endsWith('0') ? '1' : '0'}`],
    ['el número del documento', `<cbc:ID>${DOC.fullNumber}</cbc:ID>`, '<cbc:ID>SETP990000999</cbc:ID>'],
    ['el ambiente', '<cbc:ProfileExecutionID>2<', '<cbc:ProfileExecutionID>1<'],
    ['el adquiriente', '222222222222', '222222222221'],
  ])('cambiar %s después de firmar invalida la firma', (_que, antes, despues) => {
    expect(FIRMADO).toContain(antes);
    invalida(FIRMADO.replace(antes, despues), /no coincide/);
  });

  it('añadir un elemento al documento firmado (una línea más) invalida la firma', () => {
    invalida(FIRMADO.replace('</Invoice>', '<cbc:Note xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">extra</cbc:Note></Invoice>'));
  });

  it('un documento sin firma, o con la firma duplicada, no verifica', () => {
    invalida(SIN_FIRMA, /hay 0/);
    const bloque = FIRMADO.match(BLOQUE_FIRMA)![0];
    invalida(FIRMADO.replace(bloque, bloque + bloque), /hay 2/);
  });

  it('cambiar el SignatureValue o un DigestValue invalida la firma', () => {
    const doc = new DOMParser().parseFromString(FIRMADO, 'text/xml');
    const valor = doc.getElementsByTagNameNS(NS_DS, 'SignatureValue')[0]!.textContent!;
    const volteado = (valor[0] === 'A' ? 'B' : 'A') + valor.slice(1);
    invalida(FIRMADO.replace(valor, volteado), /no coincide/);
    const resumen = doc.getElementsByTagNameNS(NS_DS, 'DigestValue')[0]!.textContent!;
    invalida(FIRMADO.replace(resumen, (resumen[0] === 'A' ? 'B' : 'A') + resumen.slice(1)), /no coincide/);
  });

  it('reemplazar el certificado de KeyInfo por el de otra empresa invalida la firma', () => {
    const deOtro = firmarXml(SIN_FIRMA, OTRO);
    const cert = (xml: string): string =>
      new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS_DS, 'X509Certificate')[0]!.textContent!;
    expect(cert(deOtro)).not.toBe(cert(FIRMADO));
    invalida(FIRMADO.replace(cert(FIRMADO), cert(deOtro)));
  });

  it('la firma completa de otra empresa sobre el mismo documento verifica íntegra, pero no pasa con la huella del emisor', () => {
    const deOtro = firmarXml(SIN_FIRMA, OTRO);
    // Integridad sola no dice quién firmó: por eso existe `huellaEsperada`.
    expect(verificarFirma(deOtro)).toEqual({ valida: true });
    const huella = (xml: string): string => {
      const b64 = new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS_DS, 'X509Certificate')[0]!.textContent!;
      return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
    };
    expect(verificarFirma(FIRMADO, huella(FIRMADO))).toEqual({ valida: true });
    expect(verificarFirma(deOtro, huella(FIRMADO))).toMatchObject({ valida: false, motivo: expect.stringMatching(/no es el esperado/) });
  });
});
