import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
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

import {
  CORREO_MAX_ENVIOS,
  DocumentoFeVistaService,
} from './documento-fe-vista.service';
import { enmascararCorreo } from '../../core-auth/application/mail.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const SEDE = new Types.ObjectId();
const OTRA_SEDE = new Types.ObjectId();
const DOC_ID = new Types.ObjectId();
const EMPRESA = 'emp1';
const EMISOR = 'em1';
const ruta = (t: string) => `einvoicing/${EMPRESA}/${EMISOR}/docs/${String(DOC_ID)}/documento.${t}`;

const user = (sedeIds: string[] = [String(SEDE)], perms: string[] = []): JwtUser =>
  ({ userId: 'u1', email: 'a@b.co', name: 'Ana', role: 'Dueño', sedeIds, permissions: perms }) as unknown as JwtUser;

type Fila = Record<string, any>;

function fila(extra: Fila = {}): Fila {
  return {
    _id: DOC_ID,
    type: 'invoice',
    sedeId: SEDE,
    fullNumber: 'FE125',
    issueDate: '2026-11-01',
    dianStatus: 'accepted',
    total: 119000,
    cufe: 'abc',
    emisor: { name: 'Café SAS', nit: '900' },
    adquiriente: { name: 'Cliente', email: 'cliente@ejemplo.co' },
    xmlPath: ruta('xml'),
    pdfPath: ruta('pdf'),
    attachedPath: ruta('zip'),
    ...extra,
  };
}

function montar(f: Fila | null) {
  const filaActual = f;
  const updates: { filtro: any; update: any }[] = [];
  let permitirReserva = true;
  const model = {
    findById: () => ({ select: () => ({ exec: async () => filaActual }), exec: async () => filaActual }),
    updateOne: (filtro: any, update: any) => ({
      exec: async () => {
        updates.push({ filtro, update });
        if (update.$inc?.['correoEntrega.envios'] === 1) {
          if (!permitirReserva) return { matchedCount: 0 };
          const c = (filaActual!.correoEntrega ??= {});
          c.envios = (c.envios ?? 0) + 1;
          c.ultimoAt = update.$set['correoEntrega.ultimoAt'];
        } else if (update.$inc?.['correoEntrega.envios'] === -1) {
          filaActual!.correoEntrega.envios -= 1;
        }
        return { matchedCount: 1 };
      },
    }),
  };
  const storage = {
    emisorDeRutaGuardada: vi.fn((_p: string, _d: string, _t: string) => EMISOR),
    urlFirmadaArtefacto: vi.fn(async (_e: string, _d: string, t: string, s: number) => `https://firmada/${t}?exp=${s}`),
    leerArtefactoGuardado: vi.fn(async () => Buffer.from('zip')),
  };
  const mail = { sendFacturaElectronica: vi.fn(async () => ({ sent: true, id: 're_1' })) };
  const entrega = { entregar: vi.fn(async () => ({ estado: 'completa' })) };
  const audit = { record: vi.fn(async (_r: unknown) => undefined) };
  const svc = new DocumentoFeVistaService(model as never, storage as never, mail as never, entrega as never, audit as never);
  return { svc, updates, storage, mail, entrega, audit, bloquearReserva: () => (permitirReserva = false), fila: filaActual };
}

const enContexto = <T>(fn: () => Promise<T>) =>
  TenantContext.run({ businessId: EMPRESA } as never, fn as never) as Promise<T>;

describe('DocumentoFeVistaService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('detalle', () => {
    it('no expone rutas del bucket y dice qué descargas hay', async () => {
      const { svc } = montar(fila());
      const d = await enContexto(() => svc.detalle(String(DOC_ID), user()));
      expect(d.descargas).toEqual({ xml: true, pdf: true, zip: true });
      expect(JSON.stringify(d)).not.toContain('einvoicing/');
      expect(d.correo.puedeEnviar).toBe(true);
      expect(d.motivos).toEqual([]);
    });
    it('un rechazado trae motivos legibles y se puede reintentar', async () => {
      const { svc } = montar(
        fila({ dianStatus: 'rejected', respuestaDian: { codigo: 'X', mensajes: ['Regla: FAJ43b, Rechazo: nombre'] } }),
      );
      const d = await enContexto(() => svc.detalle(String(DOC_ID), user()));
      expect(d.puedeReintentar).toBe(true);
      expect(d.motivos[0]!.regla).toBe('FAJ43b');
      expect(d.correo.puedeEnviar).toBe(false);
    });
    it('sede ajena da 403 y documento inexistente 404', async () => {
      const { svc } = montar(fila({ sedeId: OTRA_SEDE }));
      await expect(enContexto(() => svc.detalle(String(DOC_ID), user()))).rejects.toBeInstanceOf(ForbiddenException);
      const { svc: s2 } = montar(null);
      await expect(enContexto(() => s2.detalle(String(DOC_ID), user()))).rejects.toBeInstanceOf(NotFoundException);
      await expect(enContexto(() => s2.detalle('no-es-id', user()))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('descargas', () => {
    it('firma XML, PDF y ZIP con vida corta y no guarda ninguna URL', async () => {
      const m = montar(fila());
      const r = await enContexto(() => m.svc.descargas(String(DOC_ID), user()));
      expect(r.xml).toContain('https://firmada/xml');
      expect(r.pdf).toBeDefined();
      expect(r.zip).toBeDefined();
      expect(r.venceEn).toBeLessThanOrEqual(300);
      expect(m.updates).toHaveLength(0);
      // La auditoría no lleva URLs ni rutas.
      expect(JSON.stringify(m.audit.record.mock.calls)).not.toContain('firmada');
      expect(JSON.stringify(m.audit.record.mock.calls)).not.toContain('documento.xml');
    });
    it('solo firma lo que el documento tiene', async () => {
      const m = montar(fila({ pdfPath: undefined, attachedPath: undefined }));
      const r = await enContexto(() => m.svc.descargas(String(DOC_ID), user()));
      expect(r.xml).toBeDefined();
      expect(r.pdf).toBeUndefined();
      expect(r.zip).toBeUndefined();
    });
    it('sede ajena: 403, nada se firma y queda auditado como fallido', async () => {
      const m = montar(fila({ sedeId: OTRA_SEDE }));
      await expect(enContexto(() => m.svc.descargas(String(DOC_ID), user()))).rejects.toBeInstanceOf(ForbiddenException);
      expect(m.storage.urlFirmadaArtefacto).not.toHaveBeenCalled();
      expect(m.audit.record.mock.calls[0]![0]).toMatchObject({ success: false });
    });
    it('una ruta guardada que no valida no se firma', async () => {
      const m = montar(fila());
      m.storage.emisorDeRutaGuardada.mockImplementation(() => {
        throw new BadRequestException('Ruta de artefacto no válida');
      });
      await expect(enContexto(() => m.svc.descargas(String(DOC_ID), user()))).rejects.toBeInstanceOf(BadRequestException);
      expect(m.storage.urlFirmadaArtefacto).not.toHaveBeenCalled();
    });
  });

  describe('enviarCorreo', () => {
    it('envía el ZIP al correo del adquiriente y audita sin el correo completo', async () => {
      const m = montar(fila());
      const r = await enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user()));
      expect(m.mail.sendFacturaElectronica).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'cliente@ejemplo.co', numero: 'FE125' }),
      );
      expect(r.para).toBe('cl***@ejemplo.co');
      expect(r.envios).toBe(1);
      expect(JSON.stringify(m.audit.record.mock.calls)).not.toContain('cliente@ejemplo.co');
    });
    it.each(['draft', 'signed', 'sent', 'rejected', 'contingency'])('un documento %s no se envía', async (estado) => {
      const m = montar(fila({ dianStatus: estado }));
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user()))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(m.mail.sendFacturaElectronica).not.toHaveBeenCalled();
    });
    it('sede ajena: 403 sin enviar', async () => {
      const m = montar(fila({ sedeId: OTRA_SEDE }));
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(m.mail.sendFacturaElectronica).not.toHaveBeenCalled();
    });
    it('sin correo del adquiriente exige uno, y valida el indicado', async () => {
      const m = montar(fila({ adquiriente: { name: 'X' } }));
      const conf = user([String(SEDE)], ['einvoicing.configure']);
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user()))).rejects.toThrow(/correo/);
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), 'malo', conf))).rejects.toThrow(/válido/);
      const r = await enContexto(() => m.svc.enviarCorreo(String(DOC_ID), 'otro@dominio.co', conf));
      expect(r.envios).toBe(1);
    });
    it('un correo distinto al del adquiriente exige configure y queda guardado y auditado enmascarado', async () => {
      const m = montar(fila());
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), 'otro@dominio.co', user()))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(m.mail.sendFacturaElectronica).not.toHaveBeenCalled();
      // El mismo del adquiriente (aunque lo escriban) no exige el permiso.
      await enContexto(() => m.svc.enviarCorreo(String(DOC_ID), 'CLIENTE@ejemplo.co', user()));
      const m2 = montar(fila());
      await enContexto(() => m2.svc.enviarCorreo(String(DOC_ID), 'otro@dominio.co', user([String(SEDE)], ['einvoicing.configure'])));
      expect(m2.mail.sendFacturaElectronica).toHaveBeenCalledWith(expect.objectContaining({ to: 'otro@dominio.co' }));
      expect(m2.updates.some((u) => u.update.$set?.['correoEntrega.personalizado'] === true)).toBe(true);
      const auditado = JSON.stringify(m2.audit.record.mock.calls);
      expect(auditado).toContain('otro:ot***@dominio.co');
      expect(auditado).not.toContain('otro@dominio.co');
    });
    it('si Resend no responde no se devuelve el cupo', async () => {
      const m = montar(fila());
      m.mail.sendFacturaElectronica.mockResolvedValueOnce({ sent: false, error: 'timeout', ambiguo: true } as never);
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user()))).rejects.toThrow(/pudo haber salido/);
      expect(m.fila!.correoEntrega.envios).toBe(1);
    });
    it('el tope de envíos y la espera mínima dan 429 sin enviar', async () => {
      const m = montar(fila({ correoEntrega: { envios: CORREO_MAX_ENVIOS } }));
      m.bloquearReserva();
      const e = await enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user())).catch((x) => x);
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
      expect(m.mail.sendFacturaElectronica).not.toHaveBeenCalled();
    });
    it('si el correo no sale, el envío reservado se devuelve', async () => {
      const m = montar(fila());
      m.mail.sendFacturaElectronica.mockResolvedValueOnce({ sent: false, error: 'x' } as never);
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user()))).rejects.toThrow(/No se pudo enviar/);
      expect(m.fila!.correoEntrega.envios).toBe(0);
    });
    it('si falta el ZIP intenta la entrega una vez y, sin ZIP, no envía', async () => {
      const m = montar(fila({ attachedPath: undefined }));
      await expect(enContexto(() => m.svc.enviarCorreo(String(DOC_ID), undefined, user()))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(m.entrega.entregar).toHaveBeenCalledTimes(1);
      expect(m.mail.sendFacturaElectronica).not.toHaveBeenCalled();
    });
  });

  it('enmascararCorreo oculta el usuario', () => {
    expect(enmascararCorreo('maria@x.co')).toBe('ma***@x.co');
  });
});
