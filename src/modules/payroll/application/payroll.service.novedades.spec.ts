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

import { PayrollService } from './payroll.service';

/** Novedades de vacaciones, incapacidades y licencias (decisión 3 del dueño, tarea 11). */
const SEDE = new Types.ObjectId();
const EMP = new Types.ObjectId().toString();
const NID = new Types.ObjectId().toString();
const owner = { role: 'owner', permissions: [], sedeIds: [], email: 'o@x.co' } as any;
const otraSede = { role: 'cashier', permissions: [], sedeIds: [new Types.ObjectId().toString()], email: 'c@x.co' } as any;

function armar(
  o: { cruce?: any; cerrada?: any; actual?: any; vacaciones?: any[]; visibles?: string[]; borradores?: any[]; variables?: number } = {},
) {
  const creadas: any[] = [];
  // Almacén en memoria de novedades activas, para la prueba de concurrencia.
  const store: any[] = [];
  let actual: any = o.actual ? { ...o.actual } : null;
  const cruzan = (f: any, n: any) => n.estado === 'activa' && n.fechaInicio <= f.fechaInicio.$lte && n.fechaFin >= f.fechaFin.$gte;
  const novedades = {
    create: vi.fn(async (d: any) => {
      const doc = { ...d, _id: new Types.ObjectId() };
      creadas.push(doc);
      store.push(doc);
      return doc;
    }),
    findOne: vi.fn((f: any) => ({ exec: async () => o.cruce ?? store.find((n) => cruzan(f, n)) ?? null })),
    findById: () => ({ exec: async () => (actual ? { ...actual } : null) }),
    findOneAndUpdate: vi.fn((f: any, u: any) => ({
      exec: async () => {
        if (!actual || actual.estado !== f.estado) return null;
        actual = { ...actual, ...u.$set };
        return { ...actual };
      },
    })),
    find: vi.fn((f: any) => ({
      sort: () => ({ limit: () => ({ exec: async () => [] }) }),
      exec: async () =>
        f?._id?.$ne ? store.filter((n) => String(n._id) !== String(f._id.$ne) && cruzan(f, n)) : (o.vacaciones ?? []),
    })),
    deleteOne: vi.fn((f: any) => ({
      exec: async () => {
        const k = store.findIndex((n) => String(n._id) === String(f._id));
        if (k >= 0) store.splice(k, 1);
      },
    })),
  };
  const variables = o.variables ?? 0;
  const runs = {
    findOne: vi.fn(() => ({ select: () => ({ exec: async () => o.cerrada ?? null }) })),
    find: vi.fn((f: any) => ({
      select: () => ({
        exec: async () => (f.status === 'borrador' ? (o.borradores ?? []) : []),
        lean: () => ({
          exec: async () =>
            variables > 0 ? [{ slips: [{ employeeId: EMP, breakdown: { devengados: { horasExtra: variables } } }] }] : [],
        }),
      }),
    })),
  };
  const employees = {
    findById: () => ({
      select: () => ({ exec: async () => ({ sedeId: SEDE, firstName: 'Ana', lastName: 'Ruiz' }) }),
      exec: async () => ({ sedeId: SEDE }),
    }),
    find: vi.fn(() => ({ select: () => ({ exec: async () => (o.visibles ?? [EMP]).map((id) => ({ _id: id })) }) })),
  };
  const service = new PayrollService(
    {} as any, runs as any, employees as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any,
    novedades as any,
  );
  const recalc = vi.spyOn(service, 'recalcRun').mockResolvedValue({} as any);
  return { service, creadas, store, novedades, runs, employees, recalc, get actual() { return actual; } };
}
const base = { employeeId: EMP, tipo: 'incapacidad_comun', fechaInicio: '2026-10-06', fechaFin: '2026-10-10' };

describe('PayrollService: novedades', () => {
  it('crea la novedad con la sede del empleado y quién la registró', async () => {
    const t = armar();
    await t.service.crearNovedad({ ...base } as any, owner);
    expect(t.creadas[0]).toMatchObject({ employeeId: EMP, tipo: 'incapacidad_comun', sedeId: SEDE, estado: 'activa', creadaPor: 'o@x.co', employeeName: 'Ana Ruiz' });
  });

  it('valida fechas, días hábiles de vacaciones y prórroga solo en incapacidad común', async () => {
    const t = armar();
    await expect(t.service.crearNovedad({ ...base, fechaFin: '2026-10-01' } as any, owner)).rejects.toThrow(/anterior a la inicial/);
    await expect(t.service.crearNovedad({ ...base, fechaInicio: '2026-02-30' } as any, owner)).rejects.toThrow(/no son válidas/);
    await expect(t.service.crearNovedad({ ...base, tipo: 'vacaciones' } as any, owner)).rejects.toThrow(/días hábiles/);
    await expect(t.service.crearNovedad({ ...base, tipo: 'licencia_remunerada', diasPreviosProrroga: 3 } as any, owner)).rejects.toThrow(/prórroga/);
    await expect(t.service.crearNovedad({ ...base, fechaFin: '2028-01-01' } as any, owner)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.creadas).toHaveLength(0);
  });

  it('no se cruza con otra novedad activa ni toca un mes con nómina cerrada', async () => {
    const c = armar({ cruce: { tipo: 'vacaciones', fechaInicio: '2026-10-01', fechaFin: '2026-10-08' } });
    await expect(c.service.crearNovedad({ ...base } as any, owner)).rejects.toThrow(/Se cruza con otra novedad/);
    const z = armar({ cerrada: { period: '2026-10' } });
    await expect(z.service.crearNovedad({ ...base } as any, owner)).rejects.toThrow(/2026-10 ya está cerrada/);
    expect((z.runs.findOne as any).mock.calls[0][0]).toMatchObject({ period: { $in: ['2026-10'] }, status: 'cerrada', 'slips.employeeId': EMP });
  });

  it('D6: los días hábiles no pueden superar los días del rango', async () => {
    const t = armar();
    await expect(
      t.service.crearNovedad({ ...base, tipo: 'vacaciones', fechaInicio: '2026-10-01', fechaFin: '2026-10-05', diasHabiles: 6 } as any, owner),
    ).rejects.toThrow(/no pueden ser más que los días del rango \(5\)/);
    await expect(
      t.service.crearNovedad({ ...base, tipo: 'incapacidad_comun', salarioPromedio: 2_000_000 } as any, owner),
    ).rejects.toThrow(/solo aplica a las vacaciones/);
  });

  it('D3: recalcula las corridas en borrador de los meses que toca (al crear y al anular)', async () => {
    const t = armar({ borradores: [{ _id: 'r1', period: '2026-10' }] });
    const r = await t.service.crearNovedad({ ...base } as any, owner);
    expect(t.recalc).toHaveBeenCalledWith('r1', owner);
    expect(r.corridasRecalculadas).toEqual(['r1']);
    const filtro = (t.runs.find as any).mock.calls.find((c: any[]) => c[0].status === 'borrador')[0];
    expect(filtro.period.$in).toEqual(['2026-10']);
    const a = armar({ actual: { _id: NID, ...base, estado: 'activa' }, borradores: [{ _id: 'r2', period: '2026-10' }] });
    expect((await a.service.anularNovedad(NID, owner)).corridasRecalculadas).toEqual(['r2']);
  });

  it('D3: si el recálculo falla, la novedad queda y se avisa', async () => {
    const t = armar({ borradores: [{ _id: 'r1', period: '2026-10' }] });
    t.recalc.mockRejectedValueOnce(new Error('consumos sin amarrar'));
    const r = await t.service.crearNovedad({ ...base } as any, owner);
    expect(r.corridasRecalculadas).toEqual([]);
    expect(r.advertencias.join()).toMatch(/Recalcúlala a mano/);
  });

  it('D4: dos registros simultáneos que se cruzan: uno queda y el otro da 409', async () => {
    const t = armar();
    const r = await Promise.allSettled([
      t.service.crearNovedad({ ...base } as any, owner),
      t.service.crearNovedad({ ...base, fechaInicio: '2026-10-08', fechaFin: '2026-10-12' } as any, owner),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(t.store).toHaveLength(1);
    expect(t.novedades.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('art. 192 CST: vacaciones sin salario promedio con variables en el último año avisan', async () => {
    const vac = { ...base, tipo: 'vacaciones', fechaInicio: '2026-10-01', fechaFin: '2026-10-15', diasHabiles: 11 };
    const t = armar({ variables: 90_000 });
    expect((await t.service.crearNovedad(vac as any, owner)).advertencias.join()).toMatch(/art. 192 CST/);
    const p = armar({ variables: 90_000 });
    const conPromedio = await p.service.crearNovedad({ ...vac, salarioPromedio: 2_000_000 } as any, owner);
    expect(conPromedio.advertencias).toEqual([]);
    expect(p.creadas[0].salarioPromedio).toBe(2_000_000);
  });

  it('una novedad que cruza meses revisa todos los meses que toca', async () => {
    const t = armar();
    await t.service.crearNovedad({ ...base, fechaInicio: '2026-11-20', fechaFin: '2027-01-10' } as any, owner);
    expect((t.runs.findOne as any).mock.calls[0][0].period.$in).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('anular: atómico, no dos veces, no con nómina cerrada, y otra sede no la ve', async () => {
    const nov = { _id: NID, ...base, estado: 'activa' };
    const t = armar({ actual: nov });
    await expect(t.service.anularNovedad(NID, owner)).resolves.toMatchObject({ estado: 'anulada', anuladaPor: 'o@x.co' });
    await expect(t.service.anularNovedad(NID, owner)).rejects.toBeInstanceOf(ConflictException);
    const z = armar({ actual: nov, cerrada: { period: '2026-10' } });
    await expect(z.service.anularNovedad(NID, owner)).rejects.toThrow(/ya está cerrada/);
    const o = armar({ actual: nov });
    await expect(o.service.anularNovedad(NID, otraSede)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listar filtra por periodo y por la sede actual del empleado', async () => {
    const t = armar({ visibles: [] });
    await t.service.listarNovedades({ periodo: '2026-10' }, otraSede);
    expect((t.novedades.find as any).mock.calls[0][0]).toEqual({
      fechaInicio: { $lte: '2026-10-31' },
      fechaFin: { $gte: '2026-10-01' },
      employeeId: { $in: [] },
    });
    await expect(t.service.listarNovedades({ periodo: '2026-13' }, owner)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('la liquidación sugiere los días de vacaciones disfrutados registrados', async () => {
    const t = armar({ vacaciones: [{ tipo: 'vacaciones', fechaInicio: '2025-01-05', fechaFin: '2025-01-25', diasHabiles: 15 }] });
    await expect((t.service as any).sugerenciaVacaciones(EMP, '2024-02-01', '2026-10-20')).resolves.toEqual({ sugerencias: { vacacionesDisfrutadasDias: 15 } });
    const sin = armar({ vacaciones: [] });
    await expect((sin.service as any).sugerenciaVacaciones(EMP, '2024-02-01', '2026-10-20')).resolves.toEqual({});
  });
});
