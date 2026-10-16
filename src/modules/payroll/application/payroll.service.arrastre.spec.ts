import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
import { DEFAULT_PAYROLL_SETTINGS } from '../domain/payroll.constants';
import {
  lineasNominaCausada,
  type PartesNomina,
} from '../../core-ledger/application/ledger-posting.service';
import { ACC } from '../../core-ledger/domain/ledger.constants';

/**
 * Ítem 1.9: el neto negativo de una colilla queda a cargo del empleado en la
 * 1365. El cierre lo arrastra como deducción a la nómina siguiente, que al
 * descontarlo cancela la 1365 (no la 1305 del fiado ni la 2370 de terceros).
 *
 * Las deducciones viven en un almacén en memoria que entiende los filtros que
 * usa el servicio (igualdad, $in, $ne), para probar el ciclo completo.
 */
const exec = <T>(v: T) => ({ exec: () => Promise.resolve(v) });
const DUENA = { email: 'duena@x.co', role: 'owner', permissions: [], sedeIds: [] } as any;
const SEDE = new Types.ObjectId();

type Doc = Record<string, any>;

function igual(a: unknown, b: unknown): boolean {
  if (a instanceof Types.ObjectId || b instanceof Types.ObjectId) return String(a) === String(b);
  return a === b;
}
function cumple(d: Doc, filtro: Doc): boolean {
  return Object.entries(filtro).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Types.ObjectId)) {
      if ('$in' in v) return (v.$in as unknown[]).some((x) => igual(d[k], x));
      if ('$ne' in v) return !igual(d[k], v.$ne);
    }
    return igual(d[k], v);
  });
}
function aplicar(d: Doc, upd: Doc) {
  Object.assign(d, upd.$set ?? {});
  for (const k of Object.keys(upd.$unset ?? {})) delete d[k];
}

function almacen(iniciales: Doc[] = []) {
  const docs: Doc[] = iniciales.map((d) => ({ _id: new Types.ObjectId(), ...d }));
  const filtrar = (f: Doc) => {
    const g = { ...f };
    if (g.employeeId?.$in) {
      const ids = g.employeeId.$in as string[];
      delete g.employeeId;
      return docs.filter((d) => ids.includes(d.employeeId) && cumple(d, g));
    }
    return docs.filter((d) => cumple(d, g));
  };
  const model = {
    docs,
    find: vi.fn((f: Doc) => {
      const r = filtrar(f);
      return { exec: () => Promise.resolve(r), select: () => exec(r), sort: () => exec(r) };
    }),
    findOne: vi.fn((f: Doc) => exec(filtrar(f)[0] ?? null)),
    updateMany: vi.fn((f: Doc, upd: Doc) => {
      const r = filtrar(f);
      r.forEach((d) => aplicar(d, upd));
      return exec({ matchedCount: r.length, modifiedCount: r.length });
    }),
    updateOne: vi.fn((f: Doc, upd: Doc, opts?: { upsert?: boolean }) => {
      const r = filtrar(f)[0];
      if (r) return exec({ matchedCount: 1, upsertedCount: 0 });
      if (opts?.upsert) {
        const igualdad = Object.fromEntries(
          Object.entries(f).filter(([, v]) => !(v && typeof v === 'object' && !(v instanceof Types.ObjectId))),
        );
        docs.push({ _id: new Types.ObjectId(), ...igualdad, ...(upd.$setOnInsert ?? {}) });
        return exec({ matchedCount: 0, upsertedCount: 1 });
      }
      return exec({ matchedCount: 0, upsertedCount: 0 });
    }),
  };
  return model;
}

function slip(employeeId: string, netoPagar: number, extra: Doc = {}) {
  return {
    employeeId,
    employeeName: employeeId === 'e1' ? 'Ana Ruiz' : 'Beto Gil',
    docNumber: '1020',
    sedeId: SEDE,
    salarioBase: 2_000_000,
    netoPagar,
    otrasDeduccionesDetalle: [],
    breakdown: undefined as unknown,
    ...extra,
  };
}

function corrida(over: Doc = {}) {
  return {
    _id: new Types.ObjectId(),
    period: '2026-09',
    coverage: 'all',
    status: 'borrador',
    createdByEmail: 'duena@x.co',
    slips: [slip('e1', 1_000_000)],
    save: vi.fn(async () => undefined),
    deleteOne: vi.fn(async () => undefined),
    ...over,
  };
}

/** Empleado con turno de lunes a sábado todo el período (paga el mes). */
function turnosDelMes(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const fin = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: Doc[] = [];
  for (let d = 1; d <= fin; d++) {
    const f = new Date(Date.UTC(y, m - 1, d));
    if (f.getUTCDay() === 0) continue;
    out.push({ employeeId: 'e1', workDate: f.toISOString().slice(0, 10), checkIn: '08:00', checkOut: '15:00' });
  }
  return out;
}

function armar(o: { run?: Doc | null; deducciones?: Doc[] } = {}) {
  const settingsDoc = {
    toObject: () => ({ ...structuredClone(DEFAULT_PAYROLL_SETTINGS), exoneracionConfirmada: true }),
  };
  const creadas: Doc[] = [];
  const runs = {
    findOne: () => exec(null),
    findById: () => exec(o.run ?? null),
    create: vi.fn(async (d: Doc) => {
      const r = { ...d, _id: new Types.ObjectId() };
      creadas.push(r);
      return r;
    }),
    deleteOne: vi.fn(() => exec({})),
  };
  const empleado = {
    id: 'e1',
    firstName: 'Ana',
    lastName: 'Ruiz',
    docNumber: '1020',
    salary: 2_000_000,
    salaryType: 'ordinario',
    sedeId: SEDE,
  };
  const employees = { find: () => ({ sort: () => exec([empleado]) }), findById: () => exec(empleado) };
  const attendance = { find: () => ({ select: () => exec(turnosDelMes('2026-10')) }) };
  const deductions = almacen(o.deducciones);
  const params = {
    number: async (_k: string, fb: number) => fb,
    resolve: async () => {
      throw new Error('sin parámetro');
    },
  };
  const ledgerPosting = { postPayrollRun: vi.fn(async (_x: { partes: PartesNomina }) => undefined) };
  const service = new PayrollService(
    { findOne: () => exec(settingsDoc) } as any,
    runs as any,
    employees as any,
    attendance as any,
    {} as any,
    deductions as any,
    {} as any,
    params as any,
    ledgerPosting as any,
  );
  return { service, runs, deductions, ledgerPosting, creadas };
}

const id = () => new Types.ObjectId().toString();
const arrastres = (deductions: ReturnType<typeof almacen>) =>
  deductions.docs.filter((d) => d.source === 'arrastre');

describe('PayrollService · arrastre del saldo a cargo (1365)', () => {
  let run: ReturnType<typeof corrida>;
  beforeEach(() => {
    run = corrida({ slips: [slip('e1', -50_000), slip('e2', 900_000)] });
  });

  it('neto negativo: al cerrar crea el arrastre aprobado para el período siguiente', async () => {
    const { service, deductions } = armar({ run });
    await service.closeRun(id());

    const a = arrastres(deductions);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      employeeId: 'e1',
      source: 'arrastre',
      sourceId: run._id.toString(),
      amount: 50_000,
      status: 'approved',
      concept: 'Saldo a cargo de nómina 2026-09',
      date: '2026-10-01',
    });
    expect(run.status).toBe('cerrada');
  });

  it('diciembre arrastra a enero del año siguiente', async () => {
    run = corrida({ period: '2026-12', slips: [slip('e1', -10_000), slip('e2', 500_000)] });
    const { service, deductions } = armar({ run });
    await service.closeRun(id());
    expect(arrastres(deductions)[0]!.date).toBe('2027-01-01');
  });

  it('cerrar dos veces (o reintentar un cierre que falló) no lo duplica', async () => {
    run.save.mockRejectedValueOnce(new Error('se cayó la base'));
    const { service, deductions } = armar({ run });
    await expect(service.closeRun(id())).rejects.toThrow('se cayó la base');
    run.status = 'borrador';
    await service.closeRun(id());
    await expect(service.closeRun(id())).rejects.toBeInstanceOf(BadRequestException);

    expect(arrastres(deductions)).toHaveLength(1);
  });

  it('la nómina siguiente lo descuenta y el asiento lo cancela contra la 1365', async () => {
    const origen = armar({ run });
    await origen.service.closeRun(id());
    const pendiente = arrastres(origen.deductions);

    // Nómina de octubre: toma el arrastre aprobado.
    const sig = armar({ deducciones: pendiente.map(({ _id, ...d }) => d) });
    const creada = await sig.service.createRun({ period: '2026-10' } as never, DUENA);
    const colilla = (creada as any).slips[0];
    expect(colilla.otrasDeduccionesDetalle).toEqual([
      { concept: 'Saldo a cargo de nómina 2026-09', amount: 50_000, source: 'arrastre' },
    ]);
    expect(colilla.breakdown.deducciones.otras).toBe(50_000);
    expect(arrastres(sig.deductions)[0]).toMatchObject({ status: 'applied', appliedPeriod: '2026-10' });

    // Cierre de octubre: el arrastre va a la 1365, no a la 1305 ni a la 2370.
    const runOct = { ...(creada as any), save: vi.fn(async () => undefined) };
    const cierre = armar({ run: runOct, deducciones: sig.deductions.docs });
    await cierre.service.closeRun(id());
    const partes = cierre.ledgerPosting.postPayrollRun.mock.calls[0]![0].partes;
    expect(partes).toMatchObject({ arrastre: 50_000, fiado: 0, otrasDeducciones: 0, saldoACargoEmpleados: 0 });

    const lines = lineasNominaCausada(partes);
    const suma = (lado: 'debit' | 'credit') => lines.reduce((s, l) => s + (l[lado] ?? 0), 0);
    expect(suma('debit')).toBe(suma('credit'));
    expect(lines.filter((l) => l.accountCode === ACC.CXC_TRABAJADORES)).toEqual([
      expect.objectContaining({ credit: 50_000 }),
    ]);
    expect(lines.some((l) => l.accountCode === ACC.CLIENTES)).toBe(false);
    expect(lines.some((l) => l.memo === 'Deducciones de nómina a favor de terceros')).toBe(false);
    // Octubre ya no deja saldo: no hay arrastre nuevo.
    expect(arrastres(cierre.deductions)).toHaveLength(1);
  });

  it('borrar o recalcular la corrida de origen anula el arrastre', async () => {
    // Un cierre que falló después de crear el arrastre deja la corrida en borrador.
    run.save.mockRejectedValueOnce(new Error('falla'));
    const { service, deductions } = armar({ run });
    await expect(service.closeRun(id())).rejects.toThrow();
    run.status = 'borrador';
    expect(arrastres(deductions)[0]!.status).toBe('approved');

    await service.removeRun(id());
    expect(arrastres(deductions)[0]!.status).toBe('cancelled');
    expect(run.deleteOne).toHaveBeenCalled();
  });

  it('reabrir (anularArrastresDe) lo anula; tras anularlo, un nuevo cierre lo vuelve a crear', async () => {
    const { service, deductions } = armar({ run });
    await service.closeRun(id());
    await service.anularArrastresDe(run as any);
    expect(arrastres(deductions).map((d) => d.status)).toEqual(['cancelled']);

    run.status = 'borrador';
    await service.closeRun(id());
    expect(arrastres(deductions).map((d) => d.status)).toEqual(['cancelled', 'approved']);
  });

  it('si la nómina siguiente ya lo descontó, no lo anula a escondidas', async () => {
    const { service, deductions } = armar({
      run,
      deducciones: [
        {
          source: 'arrastre',
          sourceId: run._id.toString(),
          employeeId: 'e1',
          employeeName: 'Ana Ruiz',
          amount: 50_000,
          status: 'applied',
          appliedPeriod: '2026-10',
        },
      ],
    });
    await expect(service.removeRun(id())).rejects.toBeInstanceOf(BadRequestException);
    expect(arrastres(deductions)[0]!.status).toBe('applied');
    expect(run.deleteOne).not.toHaveBeenCalled();
  });
});

describe('lineasNominaCausada · arrastre', () => {
  const base: PartesNomina = {
    neto: 0,
    seguridadSocialEmpleado: 0,
    retencionFuente: 0,
    fiado: 0,
    aportesEmpleador: 0,
    provisiones: 0,
  };
  const en = (lines: ReturnType<typeof lineasNominaCausada>, cuenta: string, lado: 'debit' | 'credit') =>
    lines.filter((l) => l.accountCode === cuenta).reduce((s, l) => s + (l[lado] ?? 0), 0);

  it('si sigue debiendo, la 1365 neta crece solo por la diferencia', () => {
    // Descuenta 50.000 del mes anterior y vuelve a quedar debiendo 20.000.
    const lines = lineasNominaCausada({ ...base, neto: 100_000, arrastre: 50_000, saldoACargoEmpleados: 20_000 });
    expect(en(lines, ACC.CXC_TRABAJADORES, 'credit')).toBe(30_000);
    expect(en(lines, ACC.CXC_TRABAJADORES, 'debit')).toBe(0);
    expect(en(lines, ACC.GASTOS_PERSONAL, 'debit')).toBe(130_000);
  });

  it('sin devengado: el arrastre que vuelve a quedar entero no mueve la 1365', () => {
    expect(lineasNominaCausada({ ...base, arrastre: 50_000, saldoACargoEmpleados: 50_000 })).toEqual([]);
  });

  it('un arrastre negativo se rechaza', () => {
    expect(() => lineasNominaCausada({ ...base, neto: 10_000, arrastre: -1 })).toThrow();
  });
});
