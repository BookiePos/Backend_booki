import { beforeAll, describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { p12DePrueba } from '../../domain/p12-de-prueba.test';
import { armarNominaAjuste, armarNominaIndividual } from '../../domain/nomina/xml-nomina';
import { modeloAjuste, modeloIndividual } from '../../domain/nomina/__fixtures__/modelo-prueba.test';
import { validarXsdNomina } from '../../domain/nomina/__fixtures__/validar-xsd-nomina.test';
import { firmarXml, verificarFirma } from './firma-xades';

/**
 * La firma XAdES es un solo perfil para todos los documentos: aquí se prueba con
 * el XML REAL que arma `xml-nomina` (102, 103 Reemplazar y 103 Eliminar), no con
 * un esqueleto. La firma verifica y el XML firmado sigue validando contra el XSD.
 */
const PASSWORD = 'clave-de-prueba';
const CTX = { tipoAmbiente: '2', softwareId: 'sw-nomina-1', softwarePin: '12345' } as const;
const AHORA = new Date('2026-11-05T15:00:00Z');
let p12: Buffer;

beforeAll(() => {
  p12 = p12DePrueba({ password: PASSWORD });
});

const casos = [
  ['NominaIndividual (102)', () => armarNominaIndividual(modeloIndividual(), CTX), 'NominaIndividual'],
  ['NominaIndividualDeAjuste Reemplazar (103)', () => armarNominaAjuste(modeloAjuste(1, 'a'.repeat(96)), CTX), 'NominaIndividualDeAjuste'],
  ['NominaIndividualDeAjuste Eliminar (103)', () => armarNominaAjuste(modeloAjuste(2, 'a'.repeat(96)), CTX), 'NominaIndividualDeAjuste'],
] as const;

describe.each(casos)('firma de %s', (_n, armar, raiz) => {
  it('la firma verifica, está en la UBLExtension y el XML sigue validando contra el XSD', async () => {
    const { xml } = armar();
    const firmado = firmarXml(xml, { p12, password: PASSWORD }, { ahora: AHORA });
    expect(verificarFirma(firmado)).toEqual({ valida: true });
    const doc = new DOMParser().parseFromString(firmado, 'text/xml');
    expect(doc.documentElement.localName).toBe(raiz);
    expect(doc.documentElement.namespaceURI).toContain('NominaIndividual');
    const extensiones = doc.getElementsByTagNameNS(
      'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
      'ExtensionContent',
    );
    expect(extensiones).toHaveLength(1);
    expect(extensiones[0]!.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')).toHaveLength(1);
    const xsd = await validarXsdNomina(firmado);
    expect(xsd.errores).toEqual([]);
    expect(xsd.valido).toBe(true);
  }, 30_000);

  it('alterar el contenido firmado invalida la firma', () => {
    const firmado = firmarXml(armar().xml, { p12, password: PASSWORD }, { ahora: AHORA });
    expect(verificarFirma(firmado.replace('Panadería', 'Panaderia'))).toMatchObject({ valida: false });
  });
});
