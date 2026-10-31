import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types, type Model } from 'mongoose';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
  type ElectronicDocumentDocument,
} from '../modules/einvoicing/infrastructure/schemas/electronic-document.schema';
import { TransmisionDianService } from '../modules/einvoicing/application/transmision-dian.service';
import type { RespuestaDian } from '../modules/einvoicing/domain/transmisor-dian';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Transmisión DIAN (Fase 4B) contra un Mongo real: los filtros condicionados
 * (estado previo + bloqueo) son los que impiden que dos llamadas simultáneas
 * firmen y transmitan dos veces; aquí se prueban con el motor de verdad.
 */
describe('transmisión DIAN · bloqueo y orden contra Mongo real', () => {
  const EMPRESA = 'abababababababababababab';
  const NIT = '900123456';
  let env: Entorno;
  let docs: Model<ElectronicDocumentDocument>;

  beforeAll(async () => {
    env = await levantarEntorno();
    docs = env.modelo(ElectronicDocument.name, ElectronicDocumentSchema);
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  const armar = (enviar: () => Promise<RespuestaDian>) => {
    const bucket = new Map<string, Buffer>();
    const transmisor = { enviar: vi.fn(enviar), consultar: vi.fn(), enviarSetPruebas: vi.fn(), rangos: vi.fn() };
    const firmante = { firmar: vi.fn(async (xml: string) => `${xml}<!--firmado-->`) };
    const svc = new TransmisionDianService(
      docs,
      {
        obtenerPorSede: async () => ({ id: 'e1', tipoAmbiente: '2', habilitado: false, nitNorm: NIT }),
        estadoConfiguracion: async () => ({ faltaParaTransmitir: [] }),
      } as never,
      {
        guardarArtefacto: async (_e: string, id: string, _t: string, b: Buffer) => {
          bucket.set(id, b);
          return { pathname: `einvoicing/${EMPRESA}/e1/docs/${id}/documento.xml` };
        },
        leerArtefacto: async (_e: string, id: string) => bucket.get(id)!,
      } as never,
      { armar: async () => '<Invoice/>' },
      firmante,
      { para: async () => transmisor } as never,
    );
    return { svc, transmisor, firmante };
  };

  const crear = () =>
    docs.create({
      type: 'invoice',
      sedeId: new Types.ObjectId(),
      prefix: 'SETP',
      number: 990000001 + Math.floor(Math.random() * 1_000_000),
      fullNumber: 'SETP990000001',
      issueDate: '2026-10-30',
      issueTime: '10:00:00-05:00',
      emisor: { nit: NIT, nitNorm: NIT },
      total: 0,
      tipoAmbiente: '2',
      cufe: 'cufe-int',
      resolution: { prefijo: 'SETP', numero: '18760000001' },
      dianStatus: 'draft',
      createdByEmail: 'a@b.co',
    });

  it('dos transmisiones simultáneas: una sola firma y un solo envío', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const ok: RespuestaDian = { ok: true, isValid: true, origen: 'dian', codigo: '00', mensajes: [] };
      const { svc, transmisor, firmante } = armar(async () => ok);
      const d = await crear();
      const resultados = await Promise.all([1, 2, 3].map(() => svc.transmitir(d.id as string)));
      expect(transmisor.enviar).toHaveBeenCalledTimes(1);
      expect(firmante.firmar).toHaveBeenCalledTimes(1);
      expect(resultados.filter((r) => r.codigo === 'EN_CURSO')).toHaveLength(2);
      const final = await docs.findById(d.id).lean().exec();
      expect(final).toMatchObject({ dianStatus: 'accepted', intentos: 1, number: d.number });
      expect(final?.bloqueoTransmision).toBeUndefined();
      expect(final?.bloqueoHasta).toBeUndefined();
    });
  });

  it('sent persistido antes de la red; sin veredicto queda en vuelo y el reintento reenvía el mismo XML', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      let estadoEnLaRed: string | undefined;
      const ref: { id?: string } = {};
      const { svc, transmisor } = armar(async () => {
        estadoEnLaRed = (await docs.findById(ref.id).lean().exec())?.dianStatus;
        return { ok: false, origen: 'adapter', codigo: 'RED', mensajes: [] };
      });
      const d = await crear();
      ref.id = d.id as string;
      await svc.transmitir(d.id as string);
      expect(estadoEnLaRed).toBe('sent');
      await svc.transmitir(d.id as string);
      const [primero, segundo] = transmisor.enviar.mock.calls.map((c) => (c as unknown[])[0]) as Array<{ xmlFirmado: string }>;
      expect(segundo!.xmlFirmado).toBe(primero!.xmlFirmado);
      expect(await docs.findById(d.id).lean().exec()).toMatchObject({ dianStatus: 'sent', intentos: 2 });
    });
  });
});
