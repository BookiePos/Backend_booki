import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// Mismo patrón que las pruebas de ventas: se neutralizan los decoradores de
// @nestjs/mongoose porque los modelos van mockeados.
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

/**
 * Ítem 1.18: la corrida REAL paga los recargos y las extras que salen de
 * Turnos (antes solo los veía el simulador), con el recargo de la fecha del
 * período, y no se cierra si sus colillas descuentan consumos que no quedaron
 * amarrados a ella.
 *
 * Constructor (orden):
 *   settings, runs, employees, attendance, sedes, deductions, mail, params,
 *   ledgerPosting
 */
const exec = <T>(v: T) => ({ exec: () => Promise.resolve(v) });
const SALARIO = 2_100_000;
const EMP = {
  id: 'e1',
  firstName: 'Ana',
  lastName: 'Ruiz',
  salary: SALARIO,
  salaryType: 'ordinario',
};

function armar(opts: {
  turnos?: { employeeId: string; workDate: string; checkIn: string; checkOut: string }[];
  dominicalParam?: { value: number; createdByEmail?: string };
  aplicadas?: { amount: number }[];
  run?: Record<string, unknown>;
  empleado?: Record<string, unknown>;
}) {
  const settings = {
    findOne: () => exec({ toObject: () => structuredClone(DEFAULT_PAYROLL_SETTINGS) }),
  };
  const created: Record<string, unknown>[] = [];
  const runs = {
    findOne: () => exec(null),
    findById: () => exec(opts.run ?? null),
    create: vi.fn(async (doc: Record<string, unknown>) => {
      created.push(doc);
      return { ...doc, _id: new Types.ObjectId() };
    }),
  };
  const employees = { find: () => ({ sort: () => exec([opts.empleado ?? EMP]) }) };
  const attendance = {
    find: vi.fn((_filtro: unknown) => ({ select: () => exec(opts.turnos ?? []) })),
  };
  const deductions = {
    find: vi.fn(() => ({
      exec: () => Promise.resolve([]),
      select: () => exec(opts.aplicadas ?? []),
    })),
    updateMany: () => exec({ matchedCount: 0 }),
  };
  const params = {
    number: async (_k: string, fb: number) => fb,
    resolve: vi.fn(async (key: string) => {
      if (key === 'recargo.dominical_festivo' && opts.dominicalParam) {
        return { key, effectiveFrom: '2026-01-01', sedeId: null, ...opts.dominicalParam };
      }
      throw new Error('sin parámetro');
    }),
  };
  const ledgerPosting = { postPayrollRun: vi.fn(async () => undefined) };
  const service = new PayrollService(
    settings as any,
    runs as any,
    employees as any,
    attendance as any,
    {} as any,
    deductions as any,
    {} as any,
    params as any,
    ledgerPosting as any,
  );
  return { service, created, attendance, ledgerPosting };
}

const USER = { email: 'dueno@x.co' } as any;
const DOMINGO = { employeeId: 'e1', workDate: '2026-09-13', checkIn: '08:00', checkOut: '16:00' };

describe('PayrollService.createRun · recargos de Turnos', () => {
  it('la colilla paga el dominical trabajado con el 90 % de septiembre de 2026', async () => {
    const { service, created } = armar({ turnos: [DOMINGO] });

    await service.createRun({ period: '2026-09' } as any, USER);

    const slip = (created[0]!.slips as any[])[0];
    expect(slip.breakdown.devengados.recargoDetalle[0].key).toBe('dominical');
    expect(slip.breakdown.devengados.recargos).toBe(Math.round((8 * SALARIO * 0.9) / 210));
  });

  it('lee Turnos desde el lunes de la semana en que empieza el período', async () => {
    const { service, attendance } = armar({ turnos: [] });

    await service.createRun({ period: '2026-10' } as any, USER);

    const filtro = attendance.find.mock.calls[0]![0] as any;
    expect(filtro.workDate.$gte).toBe('2026-09-28');
    expect(filtro.workDate.$lte).toBe('2026-10-31');
  });

  it('un dominical pactado en Parámetros por encima del legal se paga', async () => {
    const { service, created } = armar({
      turnos: [DOMINGO],
      dominicalParam: { value: 100, createdByEmail: 'dueno@x.co' },
    });

    await service.createRun({ period: '2026-09' } as any, USER);

    const slip = (created[0]!.slips as any[])[0];
    expect(slip.breakdown.devengados.recargos).toBe(Math.round((8 * SALARIO * 1) / 210));
  });

  it('la semilla de Parámetros (90 % desde enero) no adelanta el recargo legal', async () => {
    const { service, created } = armar({
      turnos: [{ ...DOMINGO, workDate: '2026-03-15' }],
      dominicalParam: { value: 90 },
    });

    await service.createRun({ period: '2026-03' } as any, USER);

    const slip = (created[0]!.slips as any[])[0];
    expect(slip.breakdown.devengados.recargos).toBe(Math.round((8 * SALARIO * 0.8) / 220));
  });
});

describe('PayrollService.createRun · salario integral', () => {
  it('no le liquida recargos de Turnos a quien gana salario integral (art. 132 CST)', async () => {
    const { service, created } = armar({
      turnos: [DOMINGO],
      empleado: { ...EMP, salary: 30_000_000, salaryType: 'integral' },
    });

    await service.createRun({ period: '2026-09' } as any, USER);

    const slip = (created[0]!.slips as any[])[0];
    expect(slip.diasTrabajados).toBe(1);
    expect(slip.breakdown.devengados.recargos).toBe(0);
    expect(slip.breakdown.devengados.recargoDetalle).toEqual([]);
  });
});

describe('PayrollService.closeRun · deducciones amarradas', () => {
  function corrida(detalle: { concept: string; amount: number }[]) {
    return {
      _id: new Types.ObjectId(),
      status: 'borrador',
      period: '2026-09',
      totals: { costo: 1 },
      slips: [{ employeeId: 'e1', otrasDeduccionesDetalle: detalle }],
      save: vi.fn(async () => undefined),
    };
  }

  it('no cierra si las colillas descuentan consumos que no quedaron aplicados a la corrida', async () => {
    const run = corrida([{ concept: 'Consumo POS', amount: 16_900 }]);
    const { service, ledgerPosting } = armar({ run, aplicadas: [] });

    await expect(service.closeRun(String(run._id))).rejects.toBeInstanceOf(BadRequestException);
    expect(run.save).not.toHaveBeenCalled();
    expect(ledgerPosting.postPayrollRun).not.toHaveBeenCalled();
  });

  it('cierra cuando las aplicadas cuadran con las colillas', async () => {
    const run = corrida([{ concept: 'Consumo POS', amount: 16_900 }]);
    const { service } = armar({ run, aplicadas: [{ amount: 16_900 }] });

    await service.closeRun(String(run._id));

    expect(run.status).toBe('cerrada');
  });
});
