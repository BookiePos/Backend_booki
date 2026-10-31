import { describe, expect, it } from 'vitest';
import { leerEjemploDian, validarXsdDian } from './__fixtures__/validar-xsd.test';

/**
 * El validador XSD de los tests acepta lo que publica la DIAN y rechaza lo que
 * no cumple: si no, un verde de los tests del builder no diría nada.
 */
describe('validador XSD (anexo FEV 1.9)', () => {
  // El ejemplo trae el QR de texto multilínea anterior a la 1.9; el XSD pide una URL.
  const generica = leerEjemploDian('generica.xml').replace(
    /<sts:QRCode>NroFactura=[\s\S]*?<\/sts:QRCode>/,
    '<sts:QRCode>https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=ejemplo</sts:QRCode>',
  );

  it('acepta el ejemplo oficial Generica.xml', async () => {
    const r = await validarXsdDian(generica, 'generica.xml');
    expect(r.errores).toEqual([]);
  }, 60_000);

  it('rechaza un hijo inventado dentro de sts:DianExtensions', async () => {
    const r = await validarXsdDian(
      generica.replace('<sts:InvoiceSource>', '<sts:Inventado/><sts:InvoiceSource>'),
      'generica-mal.xml',
    );
    expect(r.valido).toBe(false);
    expect(r.errores.join(' ')).toMatch(/Inventado/);
  }, 60_000);

  it('rechaza un elemento fuera de orden', async () => {
    const r = await validarXsdDian(
      generica.replace(/<cbc:UBLVersionID>UBL 2.1<\/cbc:UBLVersionID>/, '').replace(
        '</cbc:IssueTime>',
        '</cbc:IssueTime><cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>',
      ),
      'desordenado.xml',
    );
    expect(r.valido).toBe(false);
    expect(r.errores.join(' ')).toMatch(/UBLVersionID/);
  }, 60_000);
});
