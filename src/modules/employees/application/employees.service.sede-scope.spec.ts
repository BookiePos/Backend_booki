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

import { EmployeesService } from './employees.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.9: alcance por sede en empleados. El expediente trae salario,
 * documento y datos de contacto. Antes cualquiera con `employees.view` veía el
 * de toda la empresa, y un Administrador de la sede A editaba a la gente de la
 * B. Quien no ve todas las sedes solo ve y edita a los de las suyas; los que
 * no tienen sede son de la empresa y solo los ve quien ve todas.
 */
describe('EmployeesService · alcance por sede', () => {
  const sedeA = new Types.ObjectId();
  const sedeB = new Types.ObjectId();
  const adminA = {
    userId: 'u1',
    role: 'admin',
    permissions: ['employees.view', 'employees.manage'],
    sedeIds: [sedeA.toString()],
  } as unknown as JwtUser;
  const duena = { ...adminA, role: 'owner', sedeIds: [] } as unknown as JwtUser;

  function makeService(empleado?: Record<string, unknown>) {
    const find = vi.fn().mockReturnValue({ sort: () => ({ exec: () => Promise.resolve([]) }) });
    const model = Object.assign(
      vi.fn(function (this: Record<string, unknown>) {
        Object.assign(this, { save: vi.fn().mockResolvedValue(undefined) });
      }),
      {
        find,
        findById: vi.fn().mockReturnValue({ exec: () => Promise.resolve(empleado ?? null) }),
      },
    );
    const service = new EmployeesService(model as never, {} as never);
    return { service, find };
  }

  it('el listado se limita a las sedes del usuario', async () => {
    const { service, find } = makeService();
    await service.list(adminA);
    const filtro = find.mock.calls[0]![0] as { sedeId: { $in: Types.ObjectId[] } };
    expect(filtro.sedeId.$in.map(String)).toEqual([sedeA.toString()]);
  });

  it('el Dueño lista a todos, con o sin sede', async () => {
    const { service, find } = makeService();
    await service.list(duena);
    expect(find.mock.calls[0]![0]).toEqual({});
  });

  it('el expediente de alguien de otra sede o sin sede da 404', async () => {
    for (const sedeId of [sedeB, undefined]) {
      const { service } = makeService({ _id: new Types.ObjectId(), sedeId });
      await expect(
        service.getOrFail(new Types.ObjectId().toString(), adminA),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('no puede crear ni mover a nadie a una sede ajena, ni dejarlo sin sede', async () => {
    const { service } = makeService();
    for (const sedeId of [sedeB.toString(), '', undefined]) {
      await expect(
        service.create({ docNumber: '1', firstName: 'A', lastName: 'B', sedeId } as never, adminA),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    const propio = makeService({ _id: new Types.ObjectId(), sedeId: sedeA, save: vi.fn() });
    await expect(
      propio.service.update(
        new Types.ObjectId().toString(),
        { sedeId: sedeB.toString() } as never,
        adminA,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
