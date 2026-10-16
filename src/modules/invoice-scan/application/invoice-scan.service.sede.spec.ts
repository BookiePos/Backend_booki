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
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.10 (auditor de permisos): las facturas por foto no miraban la sede.
 * Un Gerente de la sede A listaba, abría, editaba y descartaba las facturas de
 * proveedor de la sede B. Ahora cada quien ve las de sus sedes y las que aún no
 * tienen sede (la bandeja de entrada es de la empresa); la ajena da 404.
 */
describe('InvoiceScanService · alcance por sede', () => {
  const sedeA = new Types.ObjectId();
  const sedeB = new Types.ObjectId();
  const gerenteA = {
    userId: 'g1',
    email: 'gerente@negocio.com',
    role: 'manager',
    permissions: ['finance.view', 'purchasing.manage'],
    sedeIds: [sedeA.toString()],
  } as unknown as JwtUser;
  const dueno = { ...gerenteA, role: 'owner', sedeIds: [] } as unknown as JwtUser;

  function makeService(scan: unknown) {
    const scans = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ limit: () => ({ exec: vi.fn().mockResolvedValue([]) }) }),
      }),
      findById: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(scan) }),
    };
    const storage = { remove: vi.fn() };
    const service = new InvoiceScanService(
      scans as never,
      {} as never,
      {} as never,
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, scans, storage };
  }

  const deSedeB = () => ({
    _id: new Types.ObjectId(),
    status: 'extracted',
    sedeId: sedeB,
    pages: [{ imagePathname: 'facturas/b1/x.jpg', privada: true }],
    history: [],
    save: vi.fn(),
  });

  it('el listado del Gerente se limita a sus sedes y a las que no tienen sede', async () => {
    const { service, scans } = makeService(null);
    await service.list(undefined, gerenteA);
    expect(scans.find).toHaveBeenCalledWith({
      $or: [{ sedeId: { $in: [sedeA] } }, { sedeId: null }],
    });
  });

  it('el Dueño lista todas', async () => {
    const { service, scans } = makeService(null);
    await service.list('extracted', dueno);
    expect(scans.find).toHaveBeenCalledWith({ status: 'extracted' });
  });

  it('la factura de otra sede no se abre ni se descarta', async () => {
    const scan = deSedeB();
    const { service, storage } = makeService(scan);
    const id = scan._id.toString();
    await expect(service.getOrFail(id, gerenteA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.discard(id, gerenteA)).rejects.toBeInstanceOf(NotFoundException);
    expect(scan.save).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    await expect(service.getOrFail(id, dueno)).resolves.toBe(scan);
  });

  it('la que aún no tiene sede la ve cualquiera que gestione compras', async () => {
    const scan = { ...deSedeB(), sedeId: undefined };
    const { service } = makeService(scan);
    await expect(service.getOrFail(scan._id.toString(), gerenteA)).resolves.toBe(scan);
  });

  it('no se puede mandar a una sede ajena', async () => {
    const scan = { ...deSedeB(), sedeId: undefined };
    const { service } = makeService(scan);
    await expect(
      service.update(scan._id.toString(), { sedeId: sedeB.toString() } as never, gerenteA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(scan.save).not.toHaveBeenCalled();
  });
});
