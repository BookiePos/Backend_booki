import { inflateRawSync } from 'zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

// El servicio importa el esquema: se neutralizan los decoradores (patrón de
// `orders.service.checkout.spec.ts`).
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

import { EntregaDianService } from './entrega-dian.service';
import { TransmisionDianService } from './transmision-dian.service';
import { mapearRespuestaDocumento } from '../infrastructure/dian/mapeo-respuesta';
import { applicationResponseXml, respuestaDocumento } from '../infrastructure/dian/respuestas-dian.test';
import { FirmaNoDisponibleError } from './transmision-dian.puertos';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const CUFE = '8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4';
const SEDE = new Types.ObjectId();
const FACTURA =
  '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">' +
  `<UUID>${CUFE}</UUID></Invoice>`;
const AR =
  '<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="c" xmlns:cac="a"><cac:DocumentResponse><cac:Response><cbc:ResponseCode>02</cbc:ResponseCode></cac:Response>' +
  `<cac:DocumentReference><cbc:UUID>${CUFE}</cbc:UUID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;

type Fila = Record<string, any>;

function cumple(fila: Fila, filtro: Record<string, any>): boolean {
  return Object.entries(filtro).every(([k, v]) => (k === '_id' ? String(fila._id) === String(v) : fila[k] === v));
}

function modeloFalso() {
  const filas = new Map<string, Fila>();
  const escrituras: Record<string, any>[] = [];
  return {
    filas,
    escrituras,
    findById: (id: string) => ({ exec: async () => (filas.get(String(id)) ? { ...filas.get(String(id)) } : null) }),
    updateOne: (filtro: Record<string, any>, update: Record<string, any>) => ({
      exec: async () => {
        escrituras.push({ filtro, update });
        const fila = [...filas.values()].find((f) => cumple(f, filtro));
        if (fila) Object.assign(fila, update.$set ?? {});
        return { matchedCount: fila ? 1 : 0 };
      },
    }),
  };
}

/** Entradas de un ZIP leídas por el directorio central. */
function entradasZip(zip: Buffer): Record<string, Buffer> {
  const fin = zip.length - 22;
  const n = zip.readUInt16LE(fin + 10);
  let cd = zip.readUInt32LE(fin + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < n; i += 1) {
    const comp = zip.readUInt32LE(cd + 20);
    const largo = zip.readUInt16LE(cd + 28);
    const nombre = zip.subarray(cd + 46, cd + 46 + largo).toString('utf8');
    const local = zip.readUInt32LE(cd + 42);
    const ini = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out[nombre] = inflateRawSync(zip.subarray(ini, ini + comp));
    cd += 46 + largo;
  }
  return out;
}

describe('EntregaDianService (Fase 5B)', () => {
  let modelo: ReturnType<typeof modeloFalso>;
  let bucket: Map<string, Buffer>;
  let storage: EinvoicingStorageService;
  let firmante: { firmar: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let svc: EntregaDianService;

  const enEmpresa = <T>(fn: () => Promise<T>, empresa = 'b1') =>
    TenantContext.run({ businessId: empresa, dbName: `biz_${empresa}` }, fn);
  const DUENO = { userId: 'u1', email: 'd@b.co', name: 'Dueña', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;

  const sembrar = (cambios: Fila = {}): Fila => {
    const _id = new Types.ObjectId();
    const d: Fila = {
      _id,
      sedeId: SEDE,
      type: 'invoice',
      fullNumber: 'SETP990000001',
      issueDate: '2026-10-30',
      issueTime: '15:04:05-05:00',
      dianStatus: 'accepted',
      tipoAmbiente: '2',
      cufe: CUFE,
      emisor: { name: 'Crunchy SAS', nit: '900123456', nitNorm: '900123456', nitDv: '7' },
      adquiriente: { name: 'Ana', docType: '13', docNumber: '1020' },
      lines: [{ description: 'Café', qty: 1, unitPrice: 1000, base: 1000, total: 1000 }],
      taxableBase: 1000,
      ivaTotal: 0,
      discountTotal: 0,
      total: 1000,
      formaPago: '1',
      resolution: { numero: '18760000001', prefijo: 'SETP', rangoDesde: 990000000, rangoHasta: 995000000 },
      xmlPath: `einvoicing/b1/e1/docs/${String(_id)}/documento.xml`,
      respuestaDian: { ok: true, codigo: '00', recibidaAt: '2026-10-30T20:15:00.000Z', applicationResponse: Buffer.from(AR).toString('base64') },
      ...cambios,
    };
    modelo.filas.set(String(_id), d);
    bucket.set(`einvoicing/b1/e1/docs/${String(_id)}/documento.xml`, Buffer.from(FACTURA));
    return d;
  };
  const fila = (d: Fila) => modelo.filas.get(String(d._id))!;
  const entregar = (d: Fila, forzar = false) => enEmpresa(() => svc.entregar({ ...fila(d) } as never, { forzar }));

  beforeEach(() => {
    modelo = modeloFalso();
    bucket = new Map();
    storage = new EinvoicingStorageService({
      uploadPrivado: async (pathname: string, contenido: Buffer) => {
        bucket.set(pathname, contenido);
        return { pathname };
      },
      descargarPrivado: async (pathname: string) => {
        const buffer = bucket.get(pathname);
        if (!buffer) throw new Error('no existe');
        return { buffer };
      },
    } as never);
    vi.spyOn(storage, 'guardarArtefacto');
    firmante = { firmar: vi.fn(async (xml: string) => xml.replace('<ext:ExtensionContent></ext:ExtensionContent>', '<ext:ExtensionContent><ds:Signature/></ext:ExtensionContent>')) };
    audit = { record: vi.fn(async () => undefined) };
    svc = new EntregaDianService(modelo as never, storage, firmante as never, audit as never);
  });

  it('aceptado: guarda PDF y ZIP (AttachedDocument firmado + PDF) y sus rutas, sin tocar el estado DIAN', async () => {
    const d = sembrar();
    const r = await entregar(d);
    expect(r).toMatchObject({ estado: 'completa', pdf: true, zip: true });
    const base = `einvoicing/b1/e1/docs/${String(d._id)}`;
    expect(fila(d).pdfPath).toBe(`${base}/documento.pdf`);
    expect(fila(d).attachedPath).toBe(`${base}/documento.zip`);
    expect(fila(d).dianStatus).toBe('accepted');
    expect(fila(d).entregaDian).toMatchObject({ estado: 'completa', archivo: 'z0900123456000263b023381.zip' });
    // Ninguna escritura cambia `dianStatus` y todas exigen que siga `accepted`.
    for (const e of modelo.escrituras) {
      expect(e.filtro).toMatchObject({ dianStatus: 'accepted' });
      expect(e.update.$set.dianStatus).toBeUndefined();
    }
    // Firma con el emisor que firmó la factura (el de la ruta guardada).
    expect(firmante.firmar).toHaveBeenCalledWith(expect.stringContaining('<AttachedDocument'), 'e1');

    const pdf = bucket.get(`${base}/documento.pdf`)!;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const zip = entradasZip(bucket.get(`${base}/documento.zip`)!);
    expect(Object.keys(zip).sort()).toEqual(['ad0900123456000263b023381.pdf', 'ad0900123456000263b023381.xml']);
    expect(zip['ad0900123456000263b023381.pdf']!.equals(pdf)).toBe(true);
    const attached = zip['ad0900123456000263b023381.xml']!.toString('utf8');
    expect(attached).toContain('<ds:Signature/>');
    expect(attached).toContain(CUFE);
  });

  it('idempotente: si ya está completa no rehace nada; forzar reescribe las MISMAS rutas', async () => {
    const d = sembrar();
    await entregar(d);
    const subidas = (storage.guardarArtefacto as any).mock.calls.length;
    const tamBucket = bucket.size;
    expect((await entregar(d)).estado).toBe('ya_entregada');
    expect((storage.guardarArtefacto as any).mock.calls.length).toBe(subidas);
    expect((await entregar(d, true)).estado).toBe('completa');
    expect(bucket.size).toBe(tamBucket);
    expect(fila(d).attachedPath).toBe(`einvoicing/b1/e1/docs/${String(d._id)}/documento.zip`);
  });

  it('sin ApplicationResponse (el hueco de hoy): guarda solo el PDF y deja el motivo', async () => {
    const d = sembrar({ respuestaDian: { ok: true, codigo: '00' } });
    const r = await entregar(d);
    expect(r).toMatchObject({ estado: 'incompleta', motivo: 'SIN_APPLICATION_RESPONSE', pdf: true, zip: false });
    expect(fila(d).pdfPath).toBeDefined();
    expect(fila(d).attachedPath).toBeUndefined();
    expect(fila(d).entregaDian).toMatchObject({ estado: 'incompleta', motivo: 'SIN_APPLICATION_RESPONSE' });
    expect(firmante.firmar).not.toHaveBeenCalled();
    // Reintentar sin `forzar` vuelve a intentarlo (no está completa).
    expect((await entregar(d)).estado).toBe('incompleta');
  });

  it('sin certificado para firmar el contenedor: PDF sí, ZIP no, motivo claro', async () => {
    firmante.firmar.mockRejectedValue(new FirmaNoDisponibleError());
    const d = sembrar();
    const r = await entregar(d);
    expect(r).toMatchObject({ estado: 'incompleta', motivo: 'FIRMA_NO_DISPONIBLE', pdf: true, zip: false });
    expect(fila(d).attachedPath).toBeUndefined();
  });

  it('ApplicationResponse de otro documento: no arma el contenedor', async () => {
    const otra = AR.replace(CUFE, 'f'.repeat(96));
    const d = sembrar({ respuestaDian: { applicationResponse: Buffer.from(otra).toString('base64') } });
    expect(await entregar(d)).toMatchObject({ estado: 'incompleta', motivo: 'AR_OTRO_DOCUMENTO', zip: false });
  });

  it('solo documentos aceptados y facturas', async () => {
    const rechazado = sembrar({ dianStatus: 'rejected' });
    expect(await entregar(rechazado)).toMatchObject({ estado: 'omitida', motivo: 'NO_ACEPTADO' });
    const nota = sembrar({ type: 'credit_note' });
    expect(await entregar(nota)).toMatchObject({ estado: 'omitida', motivo: 'TIPO_NO_SOPORTADO' });
    expect(storage.guardarArtefacto).not.toHaveBeenCalled();
  });

  it('un fallo inesperado queda en `entregaDian` (sin mensaje) y se relanza; el estado DIAN no cambia', async () => {
    const d = sembrar();
    bucket.delete(`einvoicing/b1/e1/docs/${String(d._id)}/documento.xml`);
    await expect(entregar(d)).rejects.toThrow();
    expect(fila(d).dianStatus).toBe('accepted');
    expect(fila(d).entregaDian).toMatchObject({ estado: 'fallida', motivo: 'Error' });
  });

  it('tenancy: una ruta de XML de otra empresa no se lee', async () => {
    const d = sembrar();
    fila(d).xmlPath = `einvoicing/b2/e1/docs/${String(d._id)}/documento.xml`;
    await expect(entregar(d)).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.guardarArtefacto).not.toHaveBeenCalled();
  });

  describe('regenerar (endpoint)', () => {
    it('regenera con forzar, audita y exige acceso a la sede', async () => {
      const d = sembrar();
      const r = await enEmpresa(() => svc.regenerar(String(d._id), DUENO));
      expect(r.estado).toBe('completa');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'einvoicing.documento.entrega',
          success: true,
          path: `/einvoicing/documentos/${String(d._id)}/entrega`,
        }),
      );
      const cajero = { ...DUENO, role: 'cashier', sedeIds: [String(new Types.ObjectId())] } as unknown as JwtUser;
      await expect(enEmpresa(() => svc.regenerar(String(d._id), cajero))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('un documento no aceptado es 400; uno inexistente, 404; sin empresa, falla antes de leer', async () => {
      const d = sembrar({ dianStatus: 'sent' });
      await expect(enEmpresa(() => svc.regenerar(String(d._id), DUENO))).rejects.toBeInstanceOf(BadRequestException);
      await expect(enEmpresa(() => svc.regenerar('nada', DUENO))).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.regenerar(String(d._id), DUENO)).rejects.toThrow();
    });
  });

  describe('de punta a punta: respuesta SOAP → mapeo → limpiar → entrega', () => {
    const limpiar = (r: unknown): Fila =>
      (TransmisionDianService.prototype as unknown as { limpiar(r: unknown): Fila }).limpiar.call({}, r);
    const soap = (xml: string) =>
      respuestaDocumento('SendBillSync', {
        isValid: 'true',
        cufe: CUFE,
        xmlBase64: Buffer.from(xml, 'utf8').toString('base64'),
      });

    it('una aceptación con ApplicationResponse deja la entrega completa con ZIP', async () => {
      const r = mapearRespuestaDocumento('SendBillSync', 200, soap(applicationResponseXml(CUFE)), { cufe: CUFE });
      const guardada = limpiar(r);
      expect(typeof guardada.applicationResponse).toBe('string');
      const d = sembrar({ respuestaDian: guardada });
      const res = await entregar(d);
      expect(res).toMatchObject({ estado: 'completa', pdf: true, zip: true });
      expect(fila(d).entregaDian).toMatchObject({ estado: 'completa' });
      expect(fila(d).attachedPath).toBeTruthy();
    });

    it('una ApplicationResponse de otro documento no se guarda: la entrega queda incompleta', async () => {
      const r = mapearRespuestaDocumento('SendBillSync', 200, soap(applicationResponseXml('b'.repeat(96))), { cufe: CUFE });
      const guardada = limpiar(r);
      expect(guardada.applicationResponse).toBeUndefined();
      const d = sembrar({ respuestaDian: guardada });
      expect(await entregar(d)).toMatchObject({ estado: 'incompleta', motivo: 'SIN_APPLICATION_RESPONSE' });
    });

    it('un rechazo no guarda la ApplicationResponse aunque el contrato la traiga', () => {
      expect(limpiar({ ok: false, origen: 'dian', mensajes: [], applicationResponse: 'QUJD' }).applicationResponse).toBeUndefined();
    });
  });
});
