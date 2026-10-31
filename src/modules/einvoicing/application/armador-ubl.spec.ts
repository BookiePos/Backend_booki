import { inspect } from 'util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotImplementedException } from '@nestjs/common';

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
import { MENSAJE_BUILDER_PENDIENTE } from './transmision-dian.puertos';
import type { FiscalEmittersService } from './fiscal-emitters.service';
import type { ElectronicDocumentDocument } from '../infrastructure/schemas/electronic-document.schema';
import { firmarXml, verificarFirma } from '../infrastructure/firma/firma-xades';
import { p12DePrueba } from '../domain/p12-de-prueba.test';
import { codigoSeguridadSoftware } from '../domain/ubl/factura-ubl';
import {
  CLIENTE_NIT,
  documento,
  linea,
  PIN,
  SOFTWARE_ID,
} from '../domain/ubl/__fixtures__/factura-de-prueba.test';

/**
 * El armador real de la Fase 5A en el puerto `ArmadorXmlDian`: arma la factura
 * de venta; los demás tipos siguen en 501. Un documento que no cuadra o con
 * datos incompletos se rechaza ANTES de leer el PIN y de firmar.
 */
describe('ArmadorUblFactura', () => {
  let emisores: { obtenerPorSede: ReturnType<typeof vi.fn>; leerSecreto: ReturnType<typeof vi.fn> };
  let armador: ArmadorUblFactura;
  const doc = (d = documento({ lines: [linea({ name: 'Camisa', precio: 119_000, impuesto: 19_000, rate: 19 })], total: 119_000 }, { cliente: CLIENTE_NIT })) =>
    ({ ...d, sedeId: { toString: () => 'sede-1' } }) as unknown as ElectronicDocumentDocument;

  beforeEach(() => {
    emisores = {
      obtenerPorSede: vi.fn(async () => ({
        id: 'emisor-1',
        municipioDane: '05001',
        facturaSoftwareId: SOFTWARE_ID,
        responsableIva: true,
      })),
      leerSecreto: vi.fn(async () => PIN),
    };
    armador = new ArmadorUblFactura(emisores as unknown as FiscalEmittersService);
  });

  it('arma la factura con el SoftwareID y el código de seguridad del emisor; firma y verifica', async () => {
    const d = doc();
    const xml = await armador.armar(d);
    expect(emisores.obtenerPorSede).toHaveBeenCalledWith('sede-1');
    expect(emisores.leerSecreto).toHaveBeenCalledWith('emisor-1', 'facturaPin');
    expect(xml).toContain(`>${codigoSeguridadSoftware(SOFTWARE_ID, PIN, d.fullNumber)}</sts:SoftwareSecurityCode>`);
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${d.cufe}</cbc:UUID>`);
    expect(xml).not.toContain(PIN);
    const firmado = firmarXml(xml, { p12: p12DePrueba(), password: 'clave-de-prueba' });
    expect(verificarFirma(firmado)).toEqual({ valida: true });
  });

  it.each(['pos', 'credit_note', 'debit_note', 'payroll'])('%s sigue en 501 sin tocar el emisor', async (type) => {
    await expect(armador.armar({ ...doc(), type } as unknown as ElectronicDocumentDocument)).rejects.toThrow(
      NotImplementedException,
    );
    await expect(armador.armar({ ...doc(), type } as unknown as ElectronicDocumentDocument)).rejects.toThrow(
      MENSAJE_BUILDER_PENDIENTE,
    );
    expect(emisores.obtenerPorSede).not.toHaveBeenCalled();
  });

  it('un documento que no cuadra es 400 y no lee el PIN', async () => {
    const d = doc();
    const err = await armador
      .armar({ ...d, payableAmount: (d.payableAmount ?? 0) + 1 } as unknown as ElectronicDocumentDocument)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/no cuadra/);
    expect(emisores.leerSecreto).not.toHaveBeenCalled();
  });

  it('un adquiriente incompleto es 400, dice qué falta y no lee el PIN', async () => {
    const d = doc();
    const adquiriente = { ...(d.adquiriente as object), address: undefined };
    await expect(
      armador.armar({ ...d, adquiriente } as unknown as ElectronicDocumentDocument),
    ).rejects.toThrow(/dirección/);
    expect(emisores.leerSecreto).not.toHaveBeenCalled();
  });

  it('sin emisor fiscal o sin PIN es 400 «Falta configurar»', async () => {
    emisores.obtenerPorSede.mockResolvedValueOnce(null);
    await expect(armador.armar(doc())).rejects.toThrow(BadRequestException);
    emisores.leerSecreto.mockResolvedValueOnce(null);
    await expect(armador.armar(doc())).rejects.toThrow(/Falta configurar: el PIN/);
  });

  it('el PIN no queda en ningún error', async () => {
    const d = doc();
    const errores = await Promise.all([
      armador.armar({ ...d, payableAmount: 1 } as unknown as ElectronicDocumentDocument).catch((e: unknown) => e),
      armador.armar({ ...d, cufe: 'x' } as unknown as ElectronicDocumentDocument).catch((e: unknown) => e),
    ]);
    for (const e of errores) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect(inspect(e, { depth: 5 })).not.toContain(PIN);
      expect(JSON.stringify((e as BadRequestException).getResponse())).not.toContain(PIN);
    }
  });
});
