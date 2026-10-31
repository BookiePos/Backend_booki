import { describe, expect, it, vi } from 'vitest';

// El armador importa el servicio de emisores, que importa esquemas: se
// neutralizan los decoradores (patrón de `orders.service.checkout.spec.ts`).
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { ArmadorUblFactura } from './armador-ubl';
import type { FiscalEmittersService } from './fiscal-emitters.service';
import type { ElectronicDocumentDocument } from '../infrastructure/schemas/electronic-document.schema';
import { firmarXml, verificarFirma } from '../infrastructure/firma/firma-xades';
import { p12DePrueba } from '../domain/p12-de-prueba.test';
import { construirAttachedDocument } from '../domain/entrega/attached-document';
import {
  CLIENTE_NIT,
  documento,
  DV,
  linea,
  NIT,
  PIN,
  SOFTWARE_ID,
} from '../domain/ubl/__fixtures__/factura-de-prueba.test';

/**
 * Paso 7 de la transmisión (entrega al adquiriente, Fase 5B) con el XML REAL
 * de la Fase 5A: la factura que arma `ArmadorUblFactura`, firmada, entra al
 * AttachedDocument, que lee de ella el CUFE y las partes, y se firma de nuevo.
 */
describe('ArmadorUblFactura → entrega (AttachedDocument de la Fase 5B)', () => {
  const CERT = { p12: p12DePrueba(), password: 'clave-de-prueba' };
  const emisores = {
    obtenerPorSede: vi.fn(async () => ({
      id: 'emisor-1',
      municipioDane: '05001',
      facturaSoftwareId: SOFTWARE_ID,
      responsableIva: true,
    })),
    leerSecreto: vi.fn(async () => PIN),
  };
  const armador = new ArmadorUblFactura(emisores as unknown as FiscalEmittersService);

  it.each([
    ['consumidor final', undefined],
    ['adquiriente con NIT', CLIENTE_NIT],
  ])('%s: el AttachedDocument se arma con la factura firmada y su firma verifica', async (_n, cliente) => {
    const d = documento(
      { lines: [linea({ name: 'Camisa', precio: 119_000, impuesto: 19_000, rate: 19 })], total: 119_000 },
      { cliente },
    );
    const xmlFactura = firmarXml(
      await armador.armar({ ...d, sedeId: { toString: () => 'sede-1' } } as unknown as ElectronicDocumentDocument),
      CERT,
    );
    const ar =
      '<?xml version="1.0" encoding="UTF-8"?><ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"' +
      ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
      ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">' +
      '<cac:DocumentResponse><cac:Response><cbc:ResponseCode>02</cbc:ResponseCode></cac:Response>' +
      `<cac:DocumentReference><cbc:UUID schemeName="CUFE-SHA384">${d.cufe}</cbc:UUID></cac:DocumentReference>` +
      '</cac:DocumentResponse></ApplicationResponse>';

    const attached = construirAttachedDocument({
      fullNumber: d.fullNumber,
      cufe: d.cufe!,
      issueDate: d.issueDate,
      tipoAmbiente: d.tipoAmbiente!,
      emisor: { nombre: d.emisor!.name!, nit: NIT, dv: DV, tipoDocumento: '31' },
      adquiriente: {
        nombre: d.adquiriente!.name!,
        nit: d.adquiriente!.docNumber!,
        dv: d.adquiriente!.nitDv,
        tipoDocumento: d.adquiriente!.docType,
      },
      xmlFactura,
      applicationResponse: ar,
      validadoAt: new Date('2026-10-30T20:15:00Z'),
      ahora: new Date('2026-10-30T20:16:00Z'),
    });
    // El contenedor lleva las partes tal como las declaró la factura (con su DV).
    expect(attached).toMatch(new RegExp(`schemeID="${DV}" schemeName="31">${NIT}</cbc:CompanyID>`));
    expect(attached).toContain(d.cufe!);
    expect(attached).toContain('<![CDATA[');
    expect(verificarFirma(firmarXml(attached, CERT))).toEqual({ valida: true });
  });
});
