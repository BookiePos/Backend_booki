import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { EntregaDianService } from './entrega-dian.service';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Entrega de la factura 04 al declararla (Fase 9): PDF y XML 04 firmado sin
 * ApplicationResponse, una sola vez (archivos y correo), y al aceptarse se
 * rehace con el AttachedDocument.
 */
type Fila = Record<string, any>;
const valor = (f: Fila, k: string) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), f as any);
function cumple(f: Fila, filtro: Record<string, any>): boolean {
  return Object.entries(filtro).every(([k, v]) => {
    if (k === '_id') return String(f._id) === String(v);
    const x = valor(f, k);
    if (v && typeof v === 'object' && '$exists' in v) return (x !== undefined) === v.$exists;
    if (v && typeof v === 'object' && '$nin' in v) return !(v.$nin as unknown[]).includes(x);
    if (v instanceof Date) return x instanceof Date && x.getTime() === v.getTime();
    return x === v;
  });
}
function aplicar(f: Fila, u: Record<string, any>) {
  for (const [k, v] of Object.entries(u.$set ?? {})) {
    const partes = k.split('.');
    let o = f;
    for (const p of partes.slice(0, -1)) o = o[p] ??= {};
    o[partes[partes.length - 1] as string] = v;
  }
  for (const [k, n] of Object.entries(u.$inc ?? {})) {
    const partes = k.split('.');
    let o = f;
    for (const p of partes.slice(0, -1)) o = o[p] ??= {};
    const hoja = partes[partes.length - 1] as string;
    o[hoja] = (o[hoja] ?? 0) + (n as number);
  }
  for (const k of Object.keys(u.$unset ?? {})) delete f[k];
}

describe('EntregaDianService · contingencia 04', () => {
  let filas: Map<string, Fila>;
  let bucket: Map<string, Buffer>;
  let mail: { sendFacturaElectronica: ReturnType<typeof vi.fn> };
  let svc: EntregaDianService;
  const enEmpresa = <T>(fn: () => Promise<T>) => TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, fn);

  const sembrar = (c: Fila = {}): Fila => {
    const _id = new Types.ObjectId();
    const d: Fila = {
      _id,
      type: 'invoice',
      fullNumber: 'FE9',
      issueDate: '2026-11-06',
      issueTime: '10:00:00-05:00',
      dianStatus: 'contingency',
      tipoAmbiente: '1',
      cufe: 'c'.repeat(96),
      contingencia: { tipo: '04', declaradaAt: new Date() },
      emisor: { name: 'Crunchy SAS', nit: '900123456', nitNorm: '900123456', nitDv: '7' },
      adquiriente: { name: 'Ana', docType: '13', docNumber: '1020', email: 'ana@x.co' },
      lines: [{ description: 'Café', qty: 1, unitPrice: 1000, base: 1000, total: 1000 }],
      taxableBase: 1000,
      ivaTotal: 0,
      discountTotal: 0,
      total: 1000,
      formaPago: '1',
      resolution: { numero: '18764000001', prefijo: 'FE', rangoDesde: 1, rangoHasta: 100 },
      xmlPath: `einvoicing/b1/e1/docs/${String(_id)}/documento.xml`,
      ...c,
    };
    filas.set(String(_id), d);
    bucket.set(d.xmlPath, Buffer.from('<Invoice><cbc:InvoiceTypeCode>04</cbc:InvoiceTypeCode></Invoice>'));
    return d;
  };

  beforeEach(() => {
    filas = new Map();
    bucket = new Map();
    const modelo = {
      updateOne: (filtro: Record<string, any>, u: Record<string, any>) => ({
        exec: async () => {
          const f = [...filas.values()].find((x) => cumple(x, filtro));
          if (f) aplicar(f, u);
          return { matchedCount: f ? 1 : 0 };
        },
      }),
    };
    const storage = new EinvoicingStorageService({
      uploadPrivado: async (p: string, b: Buffer) => (bucket.set(p, b), { pathname: p }),
      descargarPrivado: async (p: string) => ({ buffer: bucket.get(p)! }),
    } as never);
    mail = { sendFacturaElectronica: vi.fn(async () => ({ sent: true, id: 'm1' })) };
    svc = new EntregaDianService(modelo as never, storage, { firmar: vi.fn() } as never, { record: vi.fn() } as never, mail as never);
  });

  it('PDF y ZIP con el XML 04 (sin AttachedDocument) y un correo al adquiriente', async () => {
    const d = sembrar();
    const r = await enEmpresa(() => svc.entregarContingencia({ ...d } as never));
    expect(r).toMatchObject({ estado: 'contingencia', pdf: true, zip: true });
    const f = filas.get(String(d._id))!;
    expect(f.entregaDian.estado).toBe('contingencia');
    expect(bucket.get(f.attachedPath)!.length).toBeGreaterThan(0);
    expect(bucket.get(f.pdfPath)!.subarray(0, 4).toString()).toBe('%PDF');
    expect(mail.sendFacturaElectronica).toHaveBeenCalledTimes(1);
    expect(mail.sendFacturaElectronica.mock.calls[0]![0]).toMatchObject({ to: 'ana@x.co', numero: 'FE9' });
  });

  it('idempotente: una segunda llamada no rehace archivos ni manda otro correo', async () => {
    const d = sembrar();
    await enEmpresa(() => svc.entregarContingencia({ ...d } as never));
    const r = await enEmpresa(() => svc.entregarContingencia({ ...filas.get(String(d._id))! } as never));
    expect(r.estado).toBe('ya_entregada');
    expect(mail.sendFacturaElectronica).toHaveBeenCalledTimes(1);
  });

  it('sin correo del adquiriente: solo los archivos; un POS 08 o una 04 ya aceptada no entran', async () => {
    const d = sembrar({ adquiriente: { name: 'Consumidor final', docNumber: '222222222222' } });
    await enEmpresa(() => svc.entregarContingencia({ ...d } as never));
    expect(mail.sendFacturaElectronica).not.toHaveBeenCalled();
    const pos = sembrar({ type: 'pos', contingencia: { tipo: '08', declaradaAt: new Date() } });
    expect((await enEmpresa(() => svc.entregarContingencia({ ...pos } as never))).estado).toBe('omitida');
    const aceptada = sembrar({ dianStatus: 'accepted' });
    expect((await enEmpresa(() => svc.entregarContingencia({ ...aceptada } as never))).estado).toBe('omitida');
  });

  it('si el armado falla, la reserva queda y se retoma pasados 10 min (no antes)', async () => {
    const d = sembrar();
    const xml = bucket.get(d.xmlPath)!;
    bucket.delete(d.xmlPath);
    await expect(enEmpresa(() => svc.entregarContingencia({ ...d } as never))).rejects.toThrow();
    const f = filas.get(String(d._id))!;
    expect(f.entregaContingencia.reservadaAt).toBeInstanceOf(Date);
    bucket.set(d.xmlPath, xml);
    // Antes de 10 min: no se retoma.
    expect((await enEmpresa(() => svc.entregarContingencia({ ...f } as never))).estado).toBe('ya_entregada');
    expect(f.entregaDian).toBeUndefined();
    // Pasados 10 min: se retoma y queda entregada.
    f.entregaContingencia.reservadaAt = new Date(Date.now() - 11 * 60_000);
    const r = await enEmpresa(() => svc.entregarContingencia({ ...f, entregaContingencia: { ...f.entregaContingencia } } as never));
    expect(r.estado).toBe('contingencia');
    expect(f.entregaContingencia.archivosAt).toBeInstanceOf(Date);
  });

  it('correo fallido: se reintenta pasados 10 min con su propia reserva, sin rehacer archivos; uno «ambiguo» no se repite', async () => {
    mail.sendFacturaElectronica.mockResolvedValueOnce({ sent: false });
    const d = sembrar();
    await enEmpresa(() => svc.entregarContingencia({ ...d } as never));
    const f = filas.get(String(d._id))!;
    expect(f.entregaContingencia).toMatchObject({ correoEnviado: false, correoIntentos: 1 });
    // Antes de 10 min, nada.
    await enEmpresa(() => svc.entregarContingencia({ ...f, entregaContingencia: { ...f.entregaContingencia } } as never));
    expect(mail.sendFacturaElectronica).toHaveBeenCalledTimes(1);
    f.entregaContingencia.correoAt = new Date(Date.now() - 11 * 60_000);
    mail.sendFacturaElectronica.mockResolvedValueOnce({ sent: false, ambiguo: true });
    await enEmpresa(() => svc.entregarContingencia({ ...f, entregaContingencia: { ...f.entregaContingencia } } as never));
    expect(mail.sendFacturaElectronica).toHaveBeenCalledTimes(2);
    expect(f.entregaContingencia).toMatchObject({ correoEnviado: 'ambiguo', correoIntentos: 2 });
    f.entregaContingencia.correoAt = new Date(Date.now() - 11 * 60_000);
    await enEmpresa(() => svc.entregarContingencia({ ...f, entregaContingencia: { ...f.entregaContingencia } } as never));
    expect(mail.sendFacturaElectronica).toHaveBeenCalledTimes(2);
  });

  it('aceptada después: `entregar` rehace la entrega aunque ya haya PDF y ZIP de contingencia', async () => {
    const d = sembrar();
    await enEmpresa(() => svc.entregarContingencia({ ...d } as never));
    const f = filas.get(String(d._id))!;
    f.dianStatus = 'accepted';
    // Sin ApplicationResponse en esta prueba: queda «incompleta» (solo PDF), pero NO «ya_entregada».
    const r = await enEmpresa(() => svc.entregar({ ...f } as never));
    expect(r.estado).toBe('incompleta');
  });
});
