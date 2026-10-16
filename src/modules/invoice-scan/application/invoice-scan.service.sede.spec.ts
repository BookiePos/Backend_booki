import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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

import { InvoiceScanService } from './invoice-scan.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.10 (auditor de permisos y revisión del PR #69): las facturas por foto
 * respetan la sede.
 *
 * - Con sede, la ve quien tenga esa sede.
 * - Sin sede, la ven el Dueño o sede.view_all y quienes compartan sede con quien
 *   la subió.
 * - Las viejas, sin uploaderSedeIds, siguen visibles como antes.
 * - La agrupación automática no une con una factura que la persona no ve.
 */
describe('InvoiceScanService · alcance por sede', () => {
  const sedeA = new Types.ObjectId();
  const sedeB = new Types.ObjectId();
  const sedeC = new Types.ObjectId();
  const gerente = (...sedes: Types.ObjectId[]) =>
    ({
      userId: 'g1',
      email: 'gerente@negocio.com',
      role: 'manager',
      permissions: ['finance.view', 'purchasing.manage'],
      sedeIds: sedes.map(String),
    }) as unknown as JwtUser;
  const gerenteA = gerente(sedeA);
  const dueno = { ...gerenteA, role: 'owner', sedeIds: [] } as unknown as JwtUser;

  function makeService(scan: unknown, opts: { sibling?: unknown } = {}) {
    const scans = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => ({ exec: vi.fn().mockResolvedValue([]) }) }),
      }),
      findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(scan) }),
      findOne: vi.fn().mockReturnValue({
        sort: () => ({ exec: vi.fn().mockResolvedValue(opts.sibling ?? null) }),
      }),
      findOneAndUpdate: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({ extractions: 1 }),
      }),
      create: vi.fn(async (doc: Record<string, unknown>) => ({
        ...doc,
        pages: doc.pages ?? [],
        save: vi.fn(),
      })),
    };
    const storage = {
      remove: vi.fn(),
      assertAvailable: vi.fn(),
      uploadPrivado: vi.fn(async (pathname: string) => ({ pathname })),
      descargarPrivado: vi.fn().mockResolvedValue({ buffer: Buffer.from([1]), mimetype: 'image/jpeg' }),
    };
    const extractor = {
      model: 'test',
      enabled: true,
      extractText: vi.fn(async () => lectura()),
      extract: vi.fn(async () => lectura()),
    };
    function lectura() {
      return {
        raw: {},
        parsed: {
          supplier: { docNumber: '900' },
          invoice: { number: 'F-1' },
          lines: [],
          totals: {},
        },
        model: 'vision',
        ms: 1,
      };
    }
    const matching = {
      matchSupplier: vi.fn().mockResolvedValue({ mode: 'unknown' }),
      matchLines: vi.fn().mockResolvedValue([]),
    };
    const service = new InvoiceScanService(
      scans as never,
      extractor as never,
      matching as never,
      storage as never,
      { consumeScan: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, scans, storage };
  }

  const scanDoc = (extra: Record<string, unknown> = {}): Record<string, any> => ({
    _id: new Types.ObjectId(),
    status: 'extracted',
    pages: [
      { imagePathname: 'facturas/b1/x.jpg', privada: true, text: 'texto' },
      { imagePathname: 'facturas/b1/y.jpg', privada: true },
    ],
    history: [],
    lineDecisions: [],
    save: vi.fn(),
    deleteOne: vi.fn(),
    markModified: vi.fn(),
    ...extra,
  });

  const ctx = { businessId: 'b1', dbName: 'biz_b1' } as never;
  const jpeg = {
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    mimetype: 'image/jpeg',
    size: 1024,
    originalname: 'f.jpg',
  };

  describe('listar y abrir', () => {
    it('el Gerente lista las de sus sedes y las sin sede que subió su gente (o viejas)', async () => {
      const { service, scans } = makeService(null);
      await service.list(undefined, gerenteA);
      expect(scans.find).toHaveBeenCalledWith({
        $or: [
          { sedeId: { $in: [sedeA] } },
          {
            sedeId: null,
            $or: [
              { uploaderSedeIds: { $exists: false } },
              { uploaderSedeIds: { $in: [sedeA] } },
            ],
          },
        ],
      });
    });

    it('el Dueño lista todas', async () => {
      const { service, scans } = makeService(null);
      await service.list('extracted', dueno);
      expect(scans.find).toHaveBeenCalledWith({ status: 'extracted' });
    });

    it('la de otra sede no se abre ni se descarta', async () => {
      const scan = scanDoc({ sedeId: sedeB });
      const { service, storage } = makeService(scan);
      const id = scan._id.toString();
      await expect(service.getOrFail(id, gerenteA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.discard(id, gerenteA)).rejects.toBeInstanceOf(NotFoundException);
      expect(scan.save).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      await expect(service.getOrFail(id, dueno)).resolves.toBe(scan);
    });

    it('sin sede: la ve quien comparte sede con quien la subió, no los demás', async () => {
      const scan = scanDoc({ sedeId: undefined, uploaderSedeIds: [sedeB, sedeC] });
      const { service } = makeService(scan);
      const id = scan._id.toString();
      await expect(service.getOrFail(id, gerente(sedeC))).resolves.toBe(scan);
      await expect(service.getOrFail(id, gerenteA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getOrFail(id, dueno)).resolves.toBe(scan);
    });

    it('sin sede y vieja (sin uploaderSedeIds): sigue visible como antes', async () => {
      const scan = scanDoc({ sedeId: undefined });
      const { service } = makeService(scan);
      await expect(service.getOrFail(scan._id.toString(), gerenteA)).resolves.toBe(scan);
    });
  });

  describe('sede al nacer', () => {
    it('quien tiene una sola sede la sube ya con esa sede', async () => {
      const { service, scans } = makeService(null);
      await TenantContext.run(ctx, () => service.upload(jpeg, gerenteA));
      expect(scans.create.mock.calls[0]![0]).toMatchObject({
        sedeId: sedeA,
        uploaderSedeIds: [sedeA],
      });
    });

    it('con varias sedes queda sin sede, pero guarda las de quien la subió', async () => {
      const { service, scans } = makeService(null);
      await TenantContext.run(ctx, () => service.upload(jpeg, gerente(sedeA, sedeB)));
      const doc = scans.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(doc.sedeId).toBeUndefined();
      expect(doc.uploaderSedeIds).toEqual([sedeA, sedeB]);
    });

    it('separar una página hereda la sede y las sedes del autor', async () => {
      const scan = scanDoc({ sedeId: sedeA, uploaderSedeIds: [sedeA] });
      const { service, scans } = makeService(scan);
      await service.split(scan._id.toString(), 1, gerenteA);
      expect(scans.create.mock.calls[0]![0]).toMatchObject({
        sedeId: sedeA,
        uploaderSedeIds: [sedeA],
      });
    });

    it('unir a mano conserva la sede del origen si el destino no tiene', async () => {
      const destino = scanDoc({ sedeId: undefined });
      const origen = scanDoc({ sedeId: sedeA });
      const { service, scans } = makeService(null);
      scans.findById
        .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(destino) })
        .mockReturnValueOnce({ exec: vi.fn().mockResolvedValue(origen) });
      const out = await service.merge(destino._id.toString(), origen._id.toString(), gerenteA);
      expect(out.sedeId).toEqual(sedeA);
    });
  });

  describe('editar la sede', () => {
    it('no se puede mandar a una sede ajena', async () => {
      const scan = scanDoc({ sedeId: undefined });
      const { service } = makeService(scan);
      await expect(
        service.update(scan._id.toString(), { sedeId: sedeB.toString() } as never, gerenteA),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(scan.save).not.toHaveBeenCalled();
    });

    it('quien no ve todas las sedes no le quita la sede', async () => {
      const scan = scanDoc({ sedeId: sedeA });
      const { service } = makeService(scan);
      await expect(
        service.update(scan._id.toString(), { sedeId: null } as never, gerenteA),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(scan.sedeId).toEqual(sedeA);
    });

    it('el Dueño sí puede dejarla sin sede', async () => {
      const scan = scanDoc({ sedeId: sedeA });
      const { service } = makeService(scan);
      await service.update(scan._id.toString(), { sedeId: null } as never, dueno);
      expect(scan.sedeId).toBeUndefined();
    });
  });

  describe('agrupación automática', () => {
    it('para el Gerente solo busca hermanas de la misma sede o sin sede a su vista', async () => {
      const scan = scanDoc({
        sedeId: sedeA,
        status: 'uploaded',
        pages: [{ imagePathname: 'facturas/b1/p2.jpg', privada: true, text: 'texto' }],
      });
      const { service, scans } = makeService(scan);
      await service.extract(scan._id.toString(), gerenteA);
      const filtro = scans.findOne.mock.calls[0]![0] as Record<string, unknown>;
      expect(filtro.$or).toEqual([
        { sedeId: sedeA },
        {
          sedeId: null,
          $or: [
            { uploaderSedeIds: { $exists: false } },
            { uploaderSedeIds: { $in: [sedeA] } },
          ],
        },
      ]);
    });

    it('para el Dueño no filtra por sede', async () => {
      const scan = scanDoc({
        status: 'uploaded',
        pages: [{ imagePathname: 'facturas/b1/p2.jpg', privada: true, text: 'texto' }],
      });
      const { service, scans } = makeService(scan);
      await service.extract(scan._id.toString(), dueno);
      const filtro = scans.findOne.mock.calls[0]![0] as Record<string, unknown>;
      expect(filtro.$or).toBeUndefined();
      expect(filtro).toMatchObject({ supplierDocNumber: '900', invoiceNumber: 'F-1' });
    });
  });
});
