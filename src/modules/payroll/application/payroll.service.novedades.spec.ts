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

function armar(o: { cruce?: any; cerrada?: any; actual?: any; vacaciones?: any[]; visibles?: string[] } = {}) {
  const creadas: any[] = [];
  let actual: any = o.actual ? { ...o.actual } : null;
  const novedades = {
    create: vi.fn(async (d: any) => { creadas.push(d); return d; }),
    findOne: vi.fn(() => ({ exec: async () => o.cruce ?? null })),
    findById: () => ({ exec: async () => (actual ? { ...actual } : null) }),
    findOneAndUpdate: vi.fn((f: any, u: any) => ({
      exec: async () => {
        if (!actual || actual.estado !== f.estado) return null;
        actual = { ...actual, ...u.$set };
        return { ...actual };
      },
    })),
    find: vi.fn(() => ({ sort: () => ({ limit: () => ({ exec: async () => [] }) }), exec: async () => o.vacaciones ?? [] })),
  };
  const runs = { findOne: vi.fn(() => ({ select: () => ({ exec: async () => o.cerrada ?? null }) })) };
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
  return { service, creadas, novedades, runs, employees, get actual() { return actual; } };
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
