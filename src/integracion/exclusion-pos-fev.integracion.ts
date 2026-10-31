import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Types, type Model } from 'mongoose';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
  type ElectronicDocumentDocument,
} from '../modules/einvoicing/infrastructure/schemas/electronic-document.schema';
import { Counter, type CounterDocument } from '../modules/sales/infrastructure/schemas/counter.schema';
import { EinvoicingService } from '../modules/einvoicing/application/einvoicing.service';
import { INDICE_EXCLUSION_FISCAL } from '../modules/einvoicing/domain/consecutivo-unico';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Exclusión POS/FEV por venta (D1, PR 7B) e idempotencia del POS contra un
 * Mongo real: el índice `documento_fiscal_por_venta` es lo que impide que dos
 * peticiones simultáneas (doble clic, o POS y FEV a la vez) dejen la misma
 * venta con dos documentos fiscales o quemen un folio de más.
 */
describe('electronic_documents · exclusión POS/FEV e idempotencia del POS', () => {
  const EMPRESA = 'cdcdcdcdcdcdcdcdcdcdcdcd';
  const SEDE = new Types.ObjectId().toString();
  const USER = { userId: 'u1', email: 'cajero@x.co', permissions: ['pos.sell'], sedeIds: [SEDE] } as never;
  let env: Entorno;
  let docs: Model<ElectronicDocumentDocument>;
  let counters: Model<CounterDocument>;

  const sede = {
    id: SEDE,
    code: 'centro',
    name: 'Centro',
    nit: '900123456-7',
    resolucionFe: { prefijo: 'FE', rangoDesde: 1, rangoHasta: 1000, claveTecnica: 'clave' },
    resolucionesFe: [{ tipoDocumento: 'pos', prefijo: 'POS', rangoDesde: 1, rangoHasta: 1000 }],
  };
  const venta = (id: Types.ObjectId) => ({
    _id: id,
    sedeId: SEDE,
    saleNumber: 'FV-000001',
    status: 'completed',
    cashierEmail: 'cajero@x.co',
    lines: [],
    payment: { method: 'cash' },
    total: 0,
  });

  const servicio = (saleId: Types.ObjectId) =>
    new EinvoicingService(
      docs,
      counters,
      { getOrFail: async () => venta(saleId) } as never,
      { findOrFail: async () => sede } as never,
      { consumeDocument: vi.fn(async () => 'monthly'), refundDocument: vi.fn(async () => undefined), findById: async () => null } as never,
      { obtenerPorSede: async () => ({ id: 'e1', tipoAmbiente: '2' }), leerSecreto: async () => 'pin' } as never,
    );

  const seq = async (id: string) => (await counters.findById(id).lean().exec())?.seq ?? 0;

  beforeAll(async () => {
    env = await levantarEntorno();
    docs = env.modelo(ElectronicDocument.name, ElectronicDocumentSchema);
    counters = env.modelo(Counter.name, null);
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  it('el índice documento_fiscal_por_venta existe y es único', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    const indices = await env.baseDe(EMPRESA).collection('electronic_documents').indexes();
    expect(indices.find((i) => i.name === INDICE_EXCLUSION_FISCAL.options.name)?.unique).toBe(true);
  });

  it('doble clic: dos POS de la misma venta a la vez dejan un solo documento y un solo folio', async () => {
    const saleId = new Types.ObjectId();
    const svc = servicio(saleId);
    const [a, b] = await env.enEmpresa(EMPRESA, () =>
      Promise.all([
        svc.createPosFromSale(saleId.toString(), 'anonimo', USER),
        svc.createPosFromSale(saleId.toString(), 'anonimo', USER),
      ]),
    );
    expect(String(a._id)).toBe(String(b._id));
    await env.enEmpresa(EMPRESA, async () => {
      expect(await docs.countDocuments({ saleId })).toBe(1);
      expect(await seq(`fe:pos:${SEDE}:POS`)).toBe(1);
    });
  });

  it('con el POS ya emitido, la FEV de la misma venta es 409 y no gasta folio de factura', async () => {
    const saleId = new Types.ObjectId();
    const svc = servicio(saleId);
    await env.enEmpresa(EMPRESA, async () => {
      await svc.createPosFromSale(saleId.toString(), 'anonimo', USER);
      const antes = await seq(`fe:${SEDE}:FE`);
      await expect(svc.createFromSale(saleId.toString(), USER)).rejects.toBeInstanceOf(ConflictException);
      expect(await seq(`fe:${SEDE}:FE`)).toBe(antes);
      expect(await docs.countDocuments({ saleId })).toBe(1);
    });
  });

  it('POS y FEV a la vez por la misma venta: queda uno solo y el otro es 409', async () => {
    const saleId = new Types.ObjectId();
    const svc = servicio(saleId);
    const r = await env.enEmpresa(EMPRESA, () =>
      Promise.allSettled([
        svc.createPosFromSale(saleId.toString(), 'anonimo', USER),
        svc.createFromSale(saleId.toString(), USER),
      ]),
    );
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rechazo = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rechazo.reason).toBeInstanceOf(ConflictException);
    await env.enEmpresa(EMPRESA, async () => {
      expect(await docs.countDocuments({ saleId })).toBe(1);
    });
  });

  it('un documento sin ventaFiscal (anulado) ya no bloquea a la venta', async () => {
    const saleId = new Types.ObjectId();
    const base = {
      sedeId: new Types.ObjectId(SEDE),
      saleId,
      issueDate: '2026-10-31',
      issueTime: '10:00:00-05:00',
      total: 0,
      createdByEmail: 'x@y.co',
    };
    await env.enEmpresa(EMPRESA, async () => {
      await docs.create({ ...base, type: 'pos', number: 900, fullNumber: 'POS900', ventaFiscal: saleId });
      await expect(
        docs.create({ ...base, type: 'invoice', number: 900, fullNumber: 'FE900', ventaFiscal: saleId }),
      ).rejects.toMatchObject({ code: 11000 });
      await docs.updateOne({ saleId, type: 'pos' }, { $unset: { ventaFiscal: '' } });
      await docs.create({ ...base, type: 'invoice', number: 901, fullNumber: 'FE901', ventaFiscal: saleId });
      expect(await docs.countDocuments({ saleId })).toBe(2);
    });
  });
});
