import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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

import { PayrollService, filtroNominables } from './payroll.service';

/** Liquidación de retiro guardada y aprobada (decisión 4 del dueño, tarea 11). */
const SEDE = new Types.ObjectId();
const EMP = new Types.ObjectId().toString();
const LID = new Types.ObjectId().toString();
const owner = { role: 'owner', permissions: [], sedeIds: [], email: 'o@x.co' } as any;
const otraSede = { role: 'cashier', permissions: [], sedeIds: [new Types.ObjectId().toString()], email: 'c@x.co' } as any;

function armar(liqInicial?: any, errorAlGuardar?: unknown) {
  const creadas: any[] = [];
  const liq: any = liqInicial
    ? { ...liqInicial, save: vi.fn(async () => { if (errorAlGuardar) throw errorAlGuardar; return liq; }) }
    : null;
  const liquidaciones = {
    create: vi.fn(async (d: any) => { creadas.push(d); return d; }),
    findById: () => ({ exec: async () => liq }),
    find: vi.fn(() => ({ sort: () => ({ limit: () => ({ exec: async () => [] }) }) })),
  };
  const empUpdate = vi.fn(() => ({ exec: async () => ({}) }));
  const employees = {
    findById: () => ({ select: () => ({ exec: async () => ({ sedeId: SEDE }) }), exec: async () => ({ sedeId: SEDE }) }),
    updateOne: empUpdate,
  };
  const service = new PayrollService(
    {} as any, {} as any, employees as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    liquidaciones as any,
  );
  vi.spyOn(service, 'liquidacion').mockResolvedValue({
    input: { employeeId: EMP, employeeName: 'Ana', salarioBase: 1_500_000, salaryType: 'ordinario', contractType: 'indefinido', fechaInicio: '2024-02-01', fechaFin: '2026-10-20', motivo: 'renuncia' },
    breakdown: { diasLiquidados: 980, diasPrima: 110, cesantias: 1, interesesCesantias: 1, prima: 1, vacaciones: 1, indemnizacion: 0, salariosPendientes: 0 } as any,
  });
  return { service, creadas, liquidaciones, empUpdate, get liq() { return liq; } };
}
const borrador = () => ({ _id: new Types.ObjectId(), employeeId: EMP, estado: 'borrador', fechaRetiro: '2026-10-20' });

describe('PayrollService: liquidación de retiro', () => {
  it('guardarLiquidacion crea un borrador con el cálculo y la sede del empleado', async () => {
    const t = armar();
    await t.service.guardarLiquidacion({ employeeId: EMP, fechaFin: '2026-10-20', motivo: 'renuncia' } as any, owner);
    expect(t.creadas[0]).toMatchObject({ employeeId: EMP, estado: 'borrador', fechaRetiro: '2026-10-20', sedeId: SEDE, creadaPor: 'o@x.co' });
    expect(t.creadas[0].breakdown.diasPrima).toBe(110);
  });

  it('guardarLiquidacion rechaza sin empleado o con salarios pendientes (el último sueldo va en la nómina)', async () => {
    const t = armar();
    await expect(t.service.guardarLiquidacion({ fechaFin: '2026-10-20', motivo: 'renuncia' } as any, owner)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      t.service.guardarLiquidacion({ employeeId: EMP, fechaFin: '2026-10-20', motivo: 'renuncia', salariosPendientes: 1 } as any, owner),
    ).rejects.toThrow(/salarios pendientes/);
    expect(t.creadas).toHaveLength(0);
  });

  it('aprobar guarda el pago, la deja fija y pone la fecha de retiro en el expediente', async () => {
    const t = armar(borrador());
    await t.service.aprobarLiquidacion(LID, { medioPago: '47', fechaPago: '2026-10-25' }, owner);
    expect(t.liq).toMatchObject({ estado: 'aprobada', pago: { medio: '47', fecha: '2026-10-25' }, aprobadaPor: 'o@x.co' });
    expect(t.empUpdate).toHaveBeenCalledWith({ _id: new Types.ObjectId(EMP) }, { $set: { terminationDate: '2026-10-20' } });
    await expect(t.service.aprobarLiquidacion(LID, { medioPago: '47', fechaPago: '2026-10-25' }, owner)).rejects.toThrow(/solo se aprueba un borrador/);
  });

  it('aprobar con pago inválido no cambia nada; un segundo aprobado del empleado da 409', async () => {
    const t = armar(borrador());
    await expect(t.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-09-30' }, owner)).rejects.toThrow(/anterior/);
    expect(t.liq.estado).toBe('borrador');
    const d = armar(borrador(), { code: 11000 });
    await expect(d.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner)).rejects.toBeInstanceOf(ConflictException);
    expect(d.empUpdate).not.toHaveBeenCalled();
  });

  it('anular deja rastro y no se anula dos veces; otra sede no la ve', async () => {
    const t = armar({ ...borrador(), estado: 'aprobada' });
    await t.service.anularLiquidacion(LID, owner);
    expect(t.liq).toMatchObject({ estado: 'anulada', anuladaPor: 'o@x.co' });
    await expect(t.service.anularLiquidacion(LID, owner)).rejects.toThrow(/ya está anulada/);
    const o = armar(borrador());
    await expect(o.service.anularLiquidacion(LID, otraSede)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listar filtra por las sedes del usuario', async () => {
    const t = armar();
    await t.service.listarLiquidaciones(EMP, otraSede);
    const filtro = (t.liquidaciones.find as any).mock.calls[0][0];
    expect(filtro.employeeId).toBe(EMP);
    expect(filtro.sedeId.$in.map(String)).toEqual(otraSede.sedeIds);
  });
});

describe('filtroNominables: el retirado del mes entra en la corrida', () => {
  it('activos con salario y retirados cuyo retiro cae en el mes', () => {
    expect(filtroNominables('2026-02')).toEqual({
      salary: { $gt: 0 },
      $or: [{ status: 'activo' }, { status: 'retirado', terminationDate: { $gte: '2026-02-01', $lte: '2026-02-28' } }],
    });
  });
});
