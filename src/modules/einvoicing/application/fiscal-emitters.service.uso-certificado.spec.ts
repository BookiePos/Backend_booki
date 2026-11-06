import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

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

import { FiscalEmittersService } from './fiscal-emitters.service';
import { FirmanteP12 } from './transmision-dian.puertos';
import { cifrar, contextoSecreto, VARIABLE_LLAVE } from '../../../shared/crypto/secretos';

const PASSWORD = 'clave-p12-que-no-debe-salir';

/**
 * Cada vez que se abre el .p12 (firmar, WS-Security) queda una fila de
 * auditoría; un intento que no pudo usarlo también. Nunca con la contraseña.
 */
describe('FiscalEmittersService.cargarCertificado · auditoría del uso de la firma', () => {
  const llaveAnterior = process.env[VARIABLE_LLAVE];
  const emisorId = new Types.ObjectId().toString();
  let emisor: any;
  let storage: { leerCertificado: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let svc: FiscalEmittersService;

  beforeEach(() => {
    process.env[VARIABLE_LLAVE] = randomBytes(32).toString('base64');
    emisor = {
      id: emisorId,
      certPath: `x/${emisorId}/cert-1.p12`,
      certHuella: 'HUELLA-ABC',
      certPasswordCifrada: cifrar(PASSWORD, contextoSecreto(emisorId, 'certPasswordCifrada')),
    };
    emisor.get = (k: string) => emisor[k];
    const model: any = {
      findById: () => ({ select: () => ({ exec: async () => emisor }), exec: async () => emisor }),
    };
    storage = { leerCertificado: vi.fn(async () => Buffer.from('p12')) };
    audit = { record: vi.fn(async () => undefined) };
    svc = new FiscalEmittersService(model, {} as any, storage as never, audit as never);
  });

  afterEach(() => {
    if (llaveAnterior === undefined) delete process.env[VARIABLE_LLAVE];
    else process.env[VARIABLE_LLAVE] = llaveAnterior;
  });

  it('firmar con el .p12 deja una fila «usado» con huella y motivo, sin la contraseña', async () => {
    const firmante = new FirmanteP12(svc);
    // El .p12 de este test no es válido: firmar falla, pero la lectura ya quedó auditada.
    await firmante.firmar('<Invoice/>', emisorId).catch(() => undefined);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const fila = audit.record.mock.calls[0]![0];
    expect(fila).toMatchObject({
      method: 'SERVER',
      success: true,
      action: 'einvoicing.certificado.usado',
      detail: { emisorId, huella: 'HUELLA-ABC', motivo: 'firma' },
    });
    expect(JSON.stringify(fila)).not.toContain(PASSWORD);
  });

  it('cada uso es una fila: dos lecturas, dos filas, con su motivo', async () => {
    await svc.cargarCertificado(emisorId, 'firma');
    await svc.cargarCertificado(emisorId, 'transmision');
    expect(audit.record.mock.calls.map((c) => c[0].detail.motivo)).toEqual(['firma', 'transmision']);
  });

  it('sin certificado: fila «uso_fallido» y null', async () => {
    delete emisor.certPath;
    expect(await svc.cargarCertificado(emisorId, 'firma')).toBeNull();
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'einvoicing.certificado.uso_fallido',
      success: false,
      error: 'sin_certificado',
    });
  });

  it('sin la llave de cifrado: fila «uso_fallido» y null', async () => {
    delete process.env[VARIABLE_LLAVE];
    expect(await svc.cargarCertificado(emisorId, 'firma')).toBeNull();
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'einvoicing.certificado.uso_fallido',
      error: 'sin_llave',
      detail: { huella: 'HUELLA-ABC' },
    });
  });

  it('si el bucket falla al leer el .p12: fila «uso_fallido» y el error sigue subiendo', async () => {
    storage.leerCertificado.mockRejectedValueOnce(new Error('bucket caído'));
    await expect(svc.cargarCertificado(emisorId, 'firma')).rejects.toThrow('bucket caído');
    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'einvoicing.certificado.uso_fallido',
      error: 'lectura_fallida',
    });
  });
});
