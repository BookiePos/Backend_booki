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

import { PayrollService } from './payroll.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 3.9: alcance por sede en nómina. Una colilla trae el salario y los
 * descuentos de cada persona. Quien no ve todas las sedes solo trabaja con las
 * corridas de SUS sedes (nunca con la consolidada de la empresa), con sus
 * empleados y con los consumos de ellos.
 */
describe('PayrollService · alcance por sede', () => {
  const sedeA = new Types.ObjectId();
  const sedeB = new Types.ObjectId();
  const adminA = {
    userId: 'u1',
    email: 'admin@a.co',
    role: 'admin',
    permissions: ['payroll.view', 'payroll.manage'],
    sedeIds: [sedeA.toString()],
  } as unknown as JwtUser;

  const q = <T>(v: T) => ({ exec: () => Promise.resolve(v) });

  function makeService(opts: {
    run?: Record<string, unknown>;
    empleado?: Record<string, unknown>;
    deduccion?: Record<string, unknown>;
  } = {}) {
    const runs = {
      find: vi.fn().mockReturnValue({
        select: () => ({ sort: () => ({ limit: () => q([]) }) }),
      }),
      findById: vi.fn().mockReturnValue(q(opts.run ?? null)),
      findOne: vi.fn(),
    };
    const employees = {
      findById: vi.fn().mockReturnValue({
        ...q(opts.empleado ?? null),
        select: () => q(opts.empleado ?? null),
      }),
      find: vi.fn(),
    };
    const deductions = {
      find: vi.fn().mockReturnValue({ sort: () => q([]) }),
      findById: vi.fn().mockReturnValue(q(opts.deduccion ?? null)),
      create: vi.fn(),
    };
    const settings = {
      findOne: vi.fn().mockReturnValue(q({ toObject: () => ({ exoneracionConfirmada: true }) })),
    };
    const service = new PayrollService(
      settings as never,
      runs as never,
      employees as never,
      {} as never,
      {} as never,
      deductions as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, runs, deductions, employees };
  }

  it('lista solo las corridas de sus sedes', async () => {
    const { service, runs } = makeService();
    await service.listRuns(adminA);
    const filtro = runs.find.mock.calls[0]![0] as {
      coverage: string;
      sedeId: { $in: Types.ObjectId[] };
    };
    expect(filtro.coverage).toBe('sede');
    expect(filtro.sedeId.$in.map(String)).toEqual([sedeA.toString()]);
  });

  it('una corrida de otra sede o de toda la empresa da 404', async () => {
    for (const run of [
      { coverage: 'sede', sedeId: sedeB, status: 'borrador', slips: [] },
      { coverage: 'all', status: 'borrador', slips: [] },
    ]) {
      const { service } = makeService({ run });
      const id = new Types.ObjectId().toString();
      await expect(service.getRun(id, adminA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.closeRun(id, adminA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.removeRun(id, adminA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.recalcRun(id, adminA)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.sendSlip(id, 'e1', adminA)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('no liquida la nómina de toda la empresa ni la de otra sede', async () => {
    const { service, runs } = makeService();
    await expect(
      service.createRun({ period: '2026-10', coverage: 'all' } as never, adminA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createRun(
        { period: '2026-10', coverage: 'sede', sedeId: sedeB.toString() } as never,
        adminA,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(runs.findOne).not.toHaveBeenCalled();
  });

  it('no simula, liquida ni descuenta a un empleado de otra sede', async () => {
    const empleado = { id: 'e1', sedeId: sedeB, salary: 2_000_000, firstName: 'A', lastName: 'B' };
    const { service, deductions } = makeService({ empleado });
    const employeeId = new Types.ObjectId().toString();
    await expect(service.preview({ employeeId } as never, adminA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.liquidacion(
        { employeeId, fechaInicio: '2026-01-01', fechaFin: '2026-10-01', motivo: 'renuncia' } as never,
        adminA,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.novedadesTurnos(employeeId, '2026-10-01', '2026-10-15', adminA),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createDeduction({ employeeId, concept: 'x', amount: 1000 } as never, adminA),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(deductions.create).not.toHaveBeenCalled();
  });

  it('los consumos: lista los de sus sedes y no aprueba los de otra', async () => {
    const { service, deductions } = makeService({
      deduccion: { status: 'pending', sedeId: sedeB, save: vi.fn() },
    });
    await service.listDeductions({}, adminA);
    const filtro = deductions.find.mock.calls[0]![0] as { sedeId: { $in: Types.ObjectId[] } };
    expect(filtro.sedeId.$in.map(String)).toEqual([sedeA.toString()]);

    const id = new Types.ObjectId().toString();
    await expect(service.approveDeduction(id, adminA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.rejectDeduction(id, adminA)).rejects.toBeInstanceOf(NotFoundException);
  });
});
