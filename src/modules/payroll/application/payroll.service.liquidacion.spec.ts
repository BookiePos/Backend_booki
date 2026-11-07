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

function armar(liqInicial?: any, errorAlAprobar?: unknown, empleadosVisibles: string[] = [EMP], corridas: any[] = []) {
  const creadas: any[] = [];
  // Almacén en memoria: findById devuelve una FOTO; findOneAndUpdate aplica la condición de forma atómica.
  let actual: any = liqInicial ? { ...liqInicial } : null;
  const cumple = (f: any) =>
    !!actual &&
    (f.estado === undefined ||
      (typeof f.estado === 'string' ? actual.estado === f.estado : actual.estado !== f.estado.$ne));
  const liquidaciones = {
    create: vi.fn(async (d: any) => { creadas.push(d); return d; }),
    findById: () => ({ exec: async () => (actual ? { ...actual } : null) }),
    findOneAndUpdate: vi.fn((f: any, u: any) => ({
      exec: async () => {
        if (errorAlAprobar) throw errorAlAprobar;
        if (!cumple(f)) return null;
        actual = { ...actual, ...u.$set };
        return { ...actual };
      },
    })),
    find: vi.fn(() => ({ sort: () => ({ limit: () => ({ exec: async () => [] }) }), select: () => ({ lean: () => ({ exec: async () => [] }) }) })),
  };
  const empUpdate = vi.fn(() => ({ exec: async () => ({}) }));
  const employees = {
    findById: () => ({
      select: () => ({ exec: async () => ({ sedeId: SEDE, hireDate: '2024-02-01' }) }),
      exec: async () => ({ sedeId: SEDE, hireDate: '2024-02-01' }),
    }),
    find: vi.fn(() => ({ select: () => ({ exec: async () => empleadosVisibles.map((id) => ({ _id: id })) }) })),
    updateOne: empUpdate,
  };
  const runs = { find: vi.fn(() => ({ select: () => ({ lean: () => ({ exec: async () => corridas }) }) })) };
  const ledgerPosting = { postLiquidacionRetiro: vi.fn(async () => undefined), reverseLiquidacionRetiro: vi.fn(async () => undefined) };
  const service = new PayrollService(
    {} as any, runs as any, employees as any, {} as any, {} as any, {} as any, {} as any, {} as any, ledgerPosting as any, {} as any,
    liquidaciones as any,
    { find: () => ({ exec: async () => [] }) } as any,
  );
  vi.spyOn(service, 'liquidacion').mockResolvedValue({
    input: { employeeId: EMP, employeeName: 'Ana', salarioBase: 1_500_000, salaryType: 'ordinario', contractType: 'indefinido', fechaInicio: '2024-02-01', fechaFin: '2026-10-20', motivo: 'renuncia' },
    breakdown: { diasLiquidados: 980, diasPrima: 110, cesantias: 1, interesesCesantias: 1, prima: 1, vacaciones: 1, indemnizacion: 0, salariosPendientes: 0, vacacionesDisfrutadasDias: 0 } as any,
    advertencias: [],
  });
  return { service, creadas, liquidaciones, employees, empUpdate, ledgerPosting, runs, get liq() { return actual; } };
}
const borrador = (o: any = {}) => ({
  _id: new Types.ObjectId(),
  employeeId: EMP,
  estado: 'borrador',
  fechaRetiro: '2026-10-20',
  breakdown: { vacacionesDisfrutadasDias: 0 },
  ...o,
});
const RETIRO = { $set: { terminationDate: '2026-10-20', status: 'retirado' } };

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

  it('guardar rechaza un employeeId inválido (400) y un retiro muy en el futuro', async () => {
    const t = armar();
    await expect(t.service.guardarLiquidacion({ employeeId: 'xyz', fechaFin: '2026-10-20', motivo: 'renuncia' } as any, owner)).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.service.guardarLiquidacion({ employeeId: EMP, fechaFin: '2999-01-01', motivo: 'renuncia' } as any, owner)).rejects.toThrow(/más de 30 días/);
    expect(t.creadas).toHaveLength(0);
  });

  it('aprobar guarda el pago y marca el retiro (fecha y estado retirado) en el expediente', async () => {
    const t = armar(borrador());
    const r = await t.service.aprobarLiquidacion(LID, { medioPago: '47', fechaPago: '2026-10-25' }, owner);
    expect(r).toMatchObject({ estado: 'aprobada', pago: { medio: '47', fecha: '2026-10-25' }, aprobadaPor: 'o@x.co' });
    expect(t.empUpdate).toHaveBeenCalledWith({ _id: new Types.ObjectId(EMP) }, RETIRO);
  });

  it('aprobar es idempotente: si ya está aprobada reaplica el retiro sin error', async () => {
    const t = armar(borrador({ estado: 'aprobada' }));
    await expect(t.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner)).resolves.toMatchObject({ estado: 'aprobada' });
    expect(t.liquidaciones.findOneAndUpdate).not.toHaveBeenCalled();
    expect(t.empUpdate).toHaveBeenCalledWith({ _id: new Types.ObjectId(EMP) }, RETIRO);
  });

  it('dos aprobaciones concurrentes: una gana y la otra da 409', async () => {
    const t = armar(borrador());
    const pago = { medioPago: '10', fechaPago: '2026-10-25' };
    const r = await Promise.allSettled([t.service.aprobarLiquidacion(LID, pago, owner), t.service.aprobarLiquidacion(LID, pago, owner)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const fallo = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(fallo.reason).toBeInstanceOf(ConflictException);
    expect(t.empUpdate).toHaveBeenCalledTimes(1);
  });

  it('aprobar sin días de vacaciones disfrutadas o con pago inválido: 400 sin cambios; índice único: 409', async () => {
    const sinVac = armar(borrador({ breakdown: {} }));
    await expect(sinVac.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner)).rejects.toThrow(/vacaciones/);
    const t = armar(borrador());
    await expect(t.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-09-30' }, owner)).rejects.toThrow(/anterior/);
    expect(t.liq.estado).toBe('borrador');
    const d = armar(borrador(), { code: 11000 });
    await expect(d.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner)).rejects.toBeInstanceOf(ConflictException);
    expect(d.empUpdate).not.toHaveBeenCalled();
    const an = armar(borrador({ estado: 'anulada' }));
    await expect(an.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aprobar avisa (sin bloquear) si una corrida cerrada del mes ya pagó más días que hasta el retiro', async () => {
    const cerrada = [{ slips: [{ employeeId: EMP, diasTrabajados: 30 }] }];
    const t = armar(borrador(), undefined, [EMP], cerrada);
    const r = await t.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner);
    expect(r.estado).toBe('aprobada');
    expect(r.advertencias.join()).toMatch(/le paga 30 días; hasta el retiro \(2026-10-20\) van 20/);
    expect(r.advertencias.join()).toMatch(/deducción o un ajuste/);
    const bien = armar(borrador(), undefined, [EMP], [{ slips: [{ employeeId: EMP, diasTrabajados: 20 }] }]);
    expect((await bien.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner)).advertencias).toEqual([]);
  });

  it('reaprobar con otro medio o fecha avisa que se ignoraron', async () => {
    const t = armar(borrador({ estado: 'aprobada', pago: { medio: '10', fecha: '2026-10-25' } }));
    const r = await t.service.aprobarLiquidacion(LID, { medioPago: '47', fechaPago: '2026-10-26' }, owner);
    expect(r.advertencias.join()).toMatch(/se ignoraron el medio y la fecha/);
    const igual = await t.service.aprobarLiquidacion(LID, { medioPago: '10', fechaPago: '2026-10-25' }, owner);
    expect(igual.advertencias).toEqual([]);
  });

  it('anular una aprobada avisa que el empleado sigue como retirado (no lo revierte)', async () => {
    const t = armar(borrador({ estado: 'aprobada' }));
    const r = await t.service.anularLiquidacion(LID, owner);
    expect(r.advertencias.join()).toMatch(/sigue como retirado/);
    expect(t.empUpdate).not.toHaveBeenCalled();
    const b = armar(borrador());
    expect((await b.service.anularLiquidacion(LID, owner)).advertencias).toEqual([]);
  });

  it('avisa del art. 253 CST si hubo devengos variables en los últimos 3 meses', async () => {
    const conExtras = [{ slips: [{ employeeId: EMP, breakdown: { devengados: { recargos: 0, horasExtra: 80_000, comisiones: 0, bonificacionSalarial: 0 } } }] }];
    const t = armar(undefined, undefined, [EMP], conExtras);
    expect((await (t.service as any).avisoVariables(EMP, '2026-10-20')).join()).toMatch(/art. 253 CST/);
    const filtro = (t.service as any).runs.find.mock.calls[0][0];
    expect(filtro.period.$in).toEqual(['2026-10', '2026-09', '2026-08']);
    const fijo = armar(undefined, undefined, [EMP], [{ slips: [{ employeeId: EMP, breakdown: { devengados: { recargos: 0, horasExtra: 0, comisiones: 0, bonificacionSalarial: 0 } } }] }]);
    expect(await (fijo.service as any).avisoVariables(EMP, '2026-10-20')).toEqual([]);
  });

  it('anular es atómico: deja rastro y la segunda vez da 409; otra sede no la ve', async () => {
    const t = armar(borrador({ estado: 'aprobada' }));
    await expect(t.service.anularLiquidacion(LID, owner)).resolves.toMatchObject({ estado: 'anulada', anuladaPor: 'o@x.co' });
    await expect(t.service.anularLiquidacion(LID, owner)).rejects.toBeInstanceOf(ConflictException);
    const o = armar(borrador());
    await expect(o.service.anularLiquidacion(LID, otraSede)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listar filtra por la sede ACTUAL del empleado', async () => {
    const t = armar(undefined, undefined, [EMP]);
    await t.service.listarLiquidaciones(EMP, otraSede);
    expect((t.liquidaciones.find as any).mock.calls[0][0]).toEqual({ employeeId: EMP });
    const filtroEmp = (t.employees.find as any).mock.calls[0][0];
    expect(filtroEmp.sedeId.$in.map(String)).toEqual(otraSede.sedeIds);
    const fuera = armar(undefined, undefined, []);
    await fuera.service.listarLiquidaciones(EMP, otraSede);
    expect((fuera.liquidaciones.find as any).mock.calls[0][0]).toEqual({ employeeId: { $in: [] } });
    const todas = armar(undefined, undefined, [EMP]);
    await todas.service.listarLiquidaciones(undefined, owner);
    expect((todas.liquidaciones.find as any).mock.calls[0][0]).toEqual({});
  });
});

/** Evalúa el filtro como lo haría Mongo, solo con los operadores que usa `filtroNominables`. */
function cumpleFiltro(f: any, e: { status: string; terminationDate?: string; salary: number }): boolean {
  const campo = (cond: any, v: any): boolean => {
    if (cond === null || typeof cond !== 'object') return v === cond;
    if ('$not' in cond) return !campo(cond.$not, v);
    if ('$gt' in cond && !(v !== undefined && v > cond.$gt)) return false;
    if ('$gte' in cond && !(v !== undefined && v >= cond.$gte)) return false;
    if ('$lte' in cond && !(v !== undefined && v <= cond.$lte)) return false;
    if ('$lt' in cond && !(v !== undefined && v < cond.$lt)) return false;
    return true;
  };
  return Object.entries(f).every(([k, cond]) =>
    k === '$or' ? (cond as any[]).some((sub) => cumpleFiltro(sub, e)) : campo(cond, (e as any)[k]),
  );
}

describe('PayrollService: asiento y renta exenta de la liquidación', () => {
  const brk = { vacacionesDisfrutadasDias: 0, cesantias: 1_500_000, interesesCesantias: 90_000, prima: 750_000, vacaciones: 400_000, indemnizacion: 2_000_000, salariosPendientes: 0, retencionFuente: 120_000 };
  const pago = { medioPago: '10', fechaPago: '2026-10-25' };

  it('aprobar asienta la liquidación en la fecha del retiro con sus conceptos y la retención', async () => {
    const t = armar(borrador({ breakdown: brk, sedeId: SEDE, employeeName: 'Ana' }));
    await t.service.aprobarLiquidacion(LID, pago, owner);
    expect(t.ledgerPosting.postLiquidacionRetiro).toHaveBeenCalledTimes(1);
    expect(t.ledgerPosting.postLiquidacionRetiro).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-10-20',
        sedeId: String(SEDE),
        partes: { cesantias: 1_500_000, interesesCesantias: 90_000, prima: 750_000, vacaciones: 400_000, indemnizacion: 2_000_000, salariosPendientes: 0, retencionFuente: 120_000 },
      }),
    );
  });

  it('el reintento de aprobar vuelve a pedir el asiento (idempotente en el ledger por sourceId)', async () => {
    const t = armar(borrador({ estado: 'aprobada', breakdown: brk }));
    await t.service.aprobarLiquidacion(LID, pago, owner);
    expect(t.ledgerPosting.postLiquidacionRetiro).toHaveBeenCalledWith(expect.objectContaining({ liquidacionId: expect.any(String) }));
  });

  it('anular un borrador no asienta; la reversa se pide igual y sin asiento no hace nada', async () => {
    const t = armar(borrador({ breakdown: brk }));
    await t.service.anularLiquidacion(LID, owner);
    expect(t.ledgerPosting.postLiquidacionRetiro).not.toHaveBeenCalled();
    expect(t.ledgerPosting.reverseLiquidacionRetiro).toHaveBeenCalledTimes(1);
  });

  it('anular una aprobada hace el contra-asiento', async () => {
    const t = armar(borrador({ estado: 'aprobada', breakdown: brk }));
    await t.service.anularLiquidacion(LID, owner);
    expect(t.ledgerPosting.reverseLiquidacionRetiro).toHaveBeenCalledWith(expect.any(String), 'o@x.co');
  });

  it('la corrida del mes recibe por empleado la renta exenta que tomaron sus liquidaciones no anuladas', async () => {
    const t = armar();
    (t.liquidaciones.find as any).mockReturnValue({
      select: () => ({ lean: () => ({ exec: async () => [
        { employeeId: EMP, breakdown: { rentaExenta25Indemnizacion: 1_200_000 } },
        { employeeId: EMP, breakdown: { rentaExenta25Indemnizacion: 300_000 } },
        { employeeId: 'otro', breakdown: {} },
      ] }) }),
    });
    const mapa = await (t.service as any).exentaDeLiquidacionesDelMes('2026-10');
    expect(mapa.get(EMP)).toBe(1_500_000);
    expect(mapa.has('otro')).toBe(false);
    expect((t.liquidaciones.find as any).mock.calls[0][0].estado).toEqual({ $in: ['borrador', 'aprobada'] });
  });

  it('renta exenta: cuenta también la colilla en borrador del mes (no usa el tope dos veces)', async () => {
    const s = { rentaExentaMaxUvtMes: 66, uvt: 50_000, rentaExentaPorc: 0.25 } as any;
    const corrida = { slips: [{ employeeId: EMP, breakdown: { rentaExenta25: 700_000 } }] };
    const t = armar(undefined, undefined, [EMP], [corrida]);
    const usado = await (t.service as any).rentaExentaUsadaEnMes(EMP, '2026-10-20', s);
    expect(usado).toBe(700_000);
    const filtro = (t.runs.find.mock.calls as any[][])[0]![0];
    expect(filtro.status).toEqual({ $in: ['cerrada', 'borrador'] });
    expect(filtro.period).toBe('2026-10');
  });
});

describe('filtroNominables: el retirado del mes entra en la corrida', () => {
  it('el retirado de octubre (aunque siga «activo» por error) no entra en la corrida de noviembre', () => {
    const nov = filtroNominables('2026-11');
    const oct = filtroNominables('2026-10');
    const retiradoOct = { status: 'retirado', terminationDate: '2026-10-20', salary: 1 };
    const activoConRetiro = { status: 'activo', terminationDate: '2026-10-20', salary: 1 };
    expect(cumpleFiltro(oct, retiradoOct)).toBe(true);
    expect(cumpleFiltro(oct, activoConRetiro)).toBe(true);
    expect(cumpleFiltro(nov, retiradoOct)).toBe(false);
    expect(cumpleFiltro(nov, activoConRetiro)).toBe(false);
    expect(cumpleFiltro(nov, { status: 'activo', salary: 1 })).toBe(true);
    expect(cumpleFiltro(nov, { status: 'activo', terminationDate: '2026-12-15', salary: 1 })).toBe(true);
  });

  it('activos con salario y retirados cuyo retiro cae en el mes', () => {
    expect(filtroNominables('2026-02')).toEqual({
      salary: { $gt: 0 },
      $or: [
        { status: 'activo', terminationDate: { $not: { $lt: '2026-02-01' } } },
        { status: 'retirado', terminationDate: { $gte: '2026-02-01', $lte: '2026-02-28' } },
      ],
    });
  });
});
