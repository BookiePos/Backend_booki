import { describe, it, expect, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

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
import { PayrollController } from '../infrastructure/payroll.controller';
import { DEFAULT_PAYROLL_SETTINGS } from '../domain/payroll.constants';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { CreateRunDto } from './dto/create-run.dto';
import { CreateDeductionDto } from './dto/deduction.dto';
import { LiquidacionDto } from './dto/liquidacion.dto';
import { PreviewPayrollDto } from './dto/preview-payroll.dto';

/**
 * Ítem 5.4: la operación de la nómina alrededor del cálculo (que ya prueban
 * payroll-calc, turnos-classify y liquidacion-calc): ajustes, simulación,
 * corridas, recálculo, consumos, liquidación, cierre, borrado y la colilla
 * por correo. Cada error de aquí es un pago mal hecho a una persona.
 *
 * Constructor: settings, runs, employees, attendance, sedes, deductions, mail,
 * params, ledgerPosting.
 */
const exec = <T>(v: T) => ({ exec: () => Promise.resolve(v) });
const DUENA = { email: 'duena@x.co', role: 'owner', permissions: [], sedeIds: [] } as any;
const SEDE = new Types.ObjectId();

function empleado(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    firstName: 'Ana',
    lastName: 'Ruiz',
    docNumber: '1020',
    salary: 2_000_000,
    salaryType: 'ordinario',
    contractType: 'indefinido',
    hireDate: '2025-01-01',
    email: 'ana@x.co',
    sedeId: SEDE,
    ...over,
  };
}

function armar(o: {
  emp?: Record<string, unknown> | null;
  emps?: Record<string, unknown>[];
  run?: Record<string, any> | null;
  existente?: unknown;
  aprobadas?: { _id: Types.ObjectId; employeeId: string; amount: number; concept: string }[];
  matched?: number[];
  deduccion?: Record<string, any> | null;
  aplicadaVenta?: (Record<string, unknown> | null)[];
  settingsDoc?: Record<string, any> | null;
} = {}) {
  const settingsDoc = o.settingsDoc === undefined
    ? {
        toObject: () => ({ ...structuredClone(DEFAULT_PAYROLL_SETTINGS), exoneracionConfirmada: true }),
        save: vi.fn(),
      }
    : o.settingsDoc;
  const settings = {
    findOne: () => exec(settingsDoc),
    create: vi.fn(async (d: Record<string, unknown>) => ({ ...d, toObject: () => d })),
  };
  const runs = {
    findOne: () => exec(o.existente ?? null),
    findById: () => exec(o.run ?? null),
    find: vi.fn(() => ({ select: () => ({ sort: () => ({ limit: () => exec([]) }) }) })),
    create: vi.fn(async (d: Record<string, unknown>) => ({ ...d, _id: new Types.ObjectId() })),
    deleteOne: vi.fn(() => exec({})),
  };
  const employees = {
    findById: () => exec(o.emp === undefined ? empleado() : o.emp),
    find: () => ({ sort: () => exec(o.emps ?? [empleado()]) }),
  };
  const attendance = { find: () => ({ select: () => exec([]) }) };
  const sedes = { findById: () => exec({ name: 'Centro', businessName: 'Panadería SAS', nit: '900' }) };
  const matched = [...(o.matched ?? [])];
  const ventas = [...(o.aplicadaVenta ?? [null, null])];
  const deductions = {
    find: vi.fn(() => ({ exec: () => Promise.resolve(o.aprobadas ?? []), sort: () => exec([]), select: () => exec([]) })),
    findById: () => exec(o.deduccion ?? null),
    findOne: () => exec(ventas.shift() ?? null),
    create: vi.fn(async (d: unknown) => d),
    updateMany: vi.fn(() => exec({ matchedCount: matched.length ? matched.shift() : (o.aprobadas?.length ?? 0) })),
  };
  const mail = { sendPayslip: vi.fn(async () => ({ sent: true, id: 'm1' })) };
  const params = {
    number: async (_k: string, fb: number) => fb,
    resolve: async () => {
      throw new Error('sin parámetro');
    },
  };
  const ledgerPosting = { postPayrollRun: vi.fn(async () => undefined) };
  const service = new PayrollService(
    settings as any,
    runs as any,
    employees as any,
    attendance as any,
    sedes as any,
    deductions as any,
    mail as any,
    params as any,
    ledgerPosting as any,
  );
  return { service, settings, runs, deductions, mail, ledgerPosting, settingsDoc };
}

function corrida(over: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    period: '2026-09',
    label: 'Septiembre',
    coverage: 'all',
    status: 'borrador',
    slips: [
      {
        employeeId: 'e1',
        employeeName: 'Ana Ruiz',
        docNumber: '1020',
        sedeId: SEDE,
        salarioBase: 2_000_000,
        netoPagar: 1_840_000,
        otrasDeduccionesDetalle: [],
        breakdown: undefined as unknown,
      },
    ],
    save: vi.fn(),
    deleteOne: vi.fn(),
    ...over,
  };
}

describe('PayrollService · ajustes y simulación', () => {
  it('sin ajustes guardados los crea con los valores de ley', async () => {
    const { service, settings } = armar({ settingsDoc: null });
    await service.getSettings();
    expect(settings.create).toHaveBeenCalledWith(expect.objectContaining({ smmlv: DEFAULT_PAYROLL_SETTINGS.smmlv }));
  });

  it('responder la exoneración la deja confirmada', async () => {
    const { service, settingsDoc } = armar();
    await service.updateSettings({ empresaExoneradaAportes: false } as never);
    expect(settingsDoc!.exoneracionConfirmada).toBe(true);
    expect(settingsDoc!.save).toHaveBeenCalled();
  });

  it('simula con el salario del expediente o con uno a mano', async () => {
    const porEmpleado = await armar().service.preview({ employeeId: 'e1', period: '2026-09' } as never);
    expect(porEmpleado.input).toMatchObject({ employeeName: 'Ana Ruiz', salarioBase: 2_000_000, diasTrabajados: 30 });
    expect(porEmpleado.breakdown.netoPagar).toBeGreaterThan(0);

    const aMano = await armar().service.preview({ salarioBase: 1_500_000, diasTrabajados: 15 } as never);
    expect(aMano.input.diasTrabajados).toBe(15);
  });

  it('no simula sin salario', async () => {
    await expect(armar({ emp: null }).service.preview({ employeeId: 'e1' } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      armar({ emp: empleado({ salary: 0 }) }).service.preview({ employeeId: 'e1' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(armar().service.preview({} as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('las novedades de Turnos salen del período pedido', async () => {
    const n = await armar().service.novedadesTurnos('e1', '2026-09-01', '2026-09-30');
    expect(n.diasTrabajados).toBe(0);
  });
});

describe('PayrollService · corridas', () => {
  it('la cobertura por sede exige la sede', async () => {
    await expect(
      armar().service.createRun({ period: '2026-09', coverage: 'sede' } as never, DUENA),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no repite una corrida del mismo período y cobertura', async () => {
    await expect(
      armar({ existente: { _id: 'r' } }).service.createRun({ period: '2026-09' } as never, DUENA),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('sin empleados con salario no hay corrida', async () => {
    await expect(
      armar({ emps: [] }).service.createRun({ period: '2026-09' } as never, DUENA),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('respeta el cupo de empleados del plan', async () => {
    const emps = Array.from({ length: 11 }, (_, i) => empleado({ id: `e${i}` }));
    const { service } = armar({ emps });
    await expect(
      TenantContext.run({ businessId: 'b', dbName: 'biz_b', plan: 'control' } as never, () =>
        service.createRun({ period: '2026-09' } as never, DUENA),
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ quota: 'payrollEmployees' }) });
  });

  it('descuenta los consumos aprobados y los amarra a la corrida', async () => {
    const aprobadas = [{ _id: new Types.ObjectId(), employeeId: 'e1', amount: 30_000, concept: 'almuerzos' }];
    const { service, runs } = armar({ aprobadas });
    await service.createRun({ period: '2026-09', coverage: 'sede', sedeId: SEDE.toString() } as never, DUENA);
    const creada = runs.create.mock.calls[0]![0] as any;
    expect(creada.sedeId.toString()).toBe(SEDE.toString());
    expect(creada.slips[0].otrasDeduccionesDetalle).toEqual([{ concept: 'almuerzos', amount: 30_000 }]);
  });

  it('si un consumo cambió mientras se generaba, la corrida no queda a medias', async () => {
    const aprobadas = [{ _id: new Types.ObjectId(), employeeId: 'e1', amount: 30_000, concept: 'x' }];
    const { service, runs } = armar({ aprobadas, matched: [0, 0] });
    await expect(service.createRun({ period: '2026-09' } as never, DUENA)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(runs.deleteOne).toHaveBeenCalled();
  });

  it('recalcula solo en borrador, y reintenta si un consumo cambió en el camino', async () => {
    const id = new Types.ObjectId().toString();
    await expect(
      armar({ run: corrida({ status: 'cerrada' }) }).service.recalcRun(id, DUENA),
    ).rejects.toBeInstanceOf(BadRequestException);

    const aprobadas = [{ _id: new Types.ObjectId(), employeeId: 'e1', amount: 10_000, concept: 'x' }];
    const run = corrida({ coverage: 'sede', sedeId: SEDE });
    // 1: suelta las de la corrida · 2: aplica y choca · 3: suelta · 4: suelta del recálculo · 5: aplica bien.
    const { service } = armar({ run, aprobadas, matched: [0, 0, 0, 1] });
    await service.recalcRun(id, DUENA);
    expect(run.save).toHaveBeenCalled();
  });

  it('lista, cierra y borra corridas con sus reglas', async () => {
    const id = new Types.ObjectId().toString();
    await expect(armar().service.listRuns()).resolves.toEqual([]);
    await expect(armar({ run: null }).service.getRun(id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      armar({ run: corrida({ status: 'cerrada' }) }).service.closeRun(id),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      armar({ run: corrida({ status: 'cerrada' }) }).service.removeRun(id),
    ).rejects.toBeInstanceOf(BadRequestException);

    const run = corrida();
    const { service, deductions } = armar({ run });
    await service.removeRun(id);
    expect(deductions.updateMany).toHaveBeenCalled();
    expect(run.deleteOne).toHaveBeenCalled();
  });
});

describe('PayrollService · colilla por correo', () => {
  const id = new Types.ObjectId().toString();

  it('el desprendible tiene que estar en la corrida', async () => {
    await expect(armar({ run: corrida() }).service.sendSlip(id, 'otro')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('sin correo en el expediente no envía', async () => {
    const r = await armar({ run: corrida(), emp: empleado({ email: '' }) }).service.sendSlip(id, 'e1');
    expect(r).toEqual({ sent: false, error: expect.stringContaining('correo') });
  });

  it('genera el PDF con los datos de la sede y lo envía', async () => {
    const { service: s0 } = armar();
    const { breakdown } = await s0.preview({ salarioBase: 2_000_000 } as never);
    const run = corrida();
    run.slips[0]!.breakdown = breakdown;
    const { service, mail } = armar({ run });
    const r = await service.sendSlip(id, 'e1');
    expect(r).toMatchObject({ sent: true, email: 'ana@x.co' });
    const msg = (mail.sendPayslip.mock.calls[0] as any)[0];
    expect(msg).toMatchObject({ employerName: 'Panadería SAS', filename: 'comprobante-nomina-2026-09-1020.pdf' });
    expect(msg.pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('PayrollService · consumos', () => {
  it('nace pendiente y redondeado a peso', async () => {
    const { service, deductions } = armar();
    await service.createDeduction({ employeeId: 'e1', concept: 'almuerzo', amount: 12_000 } as never, DUENA);
    expect(deductions.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', amount: 12_000, source: 'manual', sedeId: SEDE }),
    );
    await expect(
      armar({ emp: null }).service.createDeduction({ employeeId: 'x', concept: 'c', amount: 1 } as never, DUENA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('solo se aprueba o rechaza lo pendiente', async () => {
    const id = new Types.ObjectId().toString();
    const pendiente = { status: 'pending', save: vi.fn() };
    expect((await armar({ deduccion: pendiente }).service.approveDeduction(id, DUENA)).status).toBe('approved');
    const otra = { status: 'pending', save: vi.fn() };
    expect((await armar({ deduccion: otra }).service.rejectDeduction(id, DUENA)).status).toBe('rejected');
    for (const m of ['approveDeduction', 'rejectDeduction'] as const) {
      await expect(
        armar({ deduccion: { status: 'applied', save: vi.fn() } }).service[m](id, DUENA),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(armar({ deduccion: null }).service.approveDeduction(id, DUENA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('anular la venta cancela su consumo, salvo que ya se haya descontado', async () => {
    await expect(armar().service.cancelSaleDeduction('v1')).resolves.toBeUndefined();
    await expect(
      armar({ aplicadaVenta: [{ appliedPeriod: '2026-09' }] }).service.cancelSaleDeduction('v1'),
    ).rejects.toThrow(/ya se descontó en la nómina 2026-09/);
    await expect(
      armar({ aplicadaVenta: [null, { appliedPeriod: '2026-10' }] }).service.cancelSaleDeduction('v1'),
    ).rejects.toThrow(/acaba de entrar/);
    const { service, deductions } = armar();
    await service.restoreSaleDeduction('v1');
    expect(deductions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
      { $set: { status: 'pending' } },
    );
  });

  it('lista con filtros de empleado y estado', async () => {
    const { service, deductions } = armar();
    await service.listDeductions({ employeeId: 'e1', status: 'approved' });
    expect(deductions.find).toHaveBeenCalledWith({ employeeId: 'e1', status: 'approved' });
  });
});

describe('PayrollService · liquidación del contrato', () => {
  const base = { fechaFin: '2026-09-30', motivo: 'renuncia' };

  it('toma salario, contrato e ingreso del expediente', async () => {
    const r = await armar().service.liquidacion({ ...base, employeeId: 'e1' } as never);
    expect(r.input).toMatchObject({ employeeName: 'Ana Ruiz', fechaInicio: '2025-01-01', contractType: 'indefinido' });
    expect(r.breakdown).toBeTruthy();
  });

  it('rechaza datos incompletos o fechas al revés', async () => {
    const s = armar().service;
    await expect(armar({ emp: null }).service.liquidacion({ ...base, employeeId: 'x' } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      armar({ emp: empleado({ salary: 0 }) }).service.liquidacion({ ...base, employeeId: 'e1' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.liquidacion({ ...base } as never)).rejects.toThrow(/salario base/);
    await expect(s.liquidacion({ ...base, salarioBase: 1_500_000 } as never)).rejects.toThrow(/fecha de inicio/);
    await expect(
      s.liquidacion({ ...base, salarioBase: 1_500_000, fechaInicio: '2026-10-01' } as never),
    ).rejects.toThrow(/posterior/);
  });
});

describe('PayrollController', () => {
  it('pasa cada petición al servicio con el usuario', async () => {
    const run = corrida();
    const { service } = armar({ run, deduccion: { status: 'pending', save: vi.fn() } });
    const c = new PayrollController(service);
    const id = new Types.ObjectId().toString();
    await c.getSettings();
    await c.updateSettings({} as never);
    await c.preview({ salarioBase: 1_500_000 } as never, DUENA);
    expect(() => c.novedadesTurnos('', '', '', DUENA)).toThrow(BadRequestException);
    await c.novedadesTurnos('e1', '2026-09-01', '2026-09-30', DUENA);
    await c.liquidacion({ salarioBase: 1, fechaInicio: '2026-01-01', fechaFin: '2026-02-01', motivo: 'renuncia' } as never, DUENA);
    await c.listRuns(DUENA);
    await c.getRun(id, DUENA);
    await c.listDeductions(undefined, undefined, DUENA);
    await c.createDeduction({ employeeId: 'e1', concept: 'c', amount: 1 } as never, DUENA);
    await c.approveDeduction(id, DUENA);
    await expect(c.rejectDeduction(id, DUENA)).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.sendSlip(id, 'e1', DUENA)).rejects.toBeTruthy();
    await expect(c.recalcRun(id, DUENA)).resolves.toBeTruthy();
    await expect(c.createRun({ period: '2026-09' } as never, DUENA)).resolves.toBeTruthy();
    await expect(c.closeRun(id, DUENA)).resolves.toBeTruthy();
    run.status = 'borrador';
    await expect(c.removeRun(id, DUENA)).resolves.toEqual({ ok: true });
  });
});

describe('DTO de nómina', () => {
  const props = <T extends object>(clase: new () => T, datos: object) =>
    validateSync(plainToInstance(clase, datos)).map((e) => e.property);

  it('validan período, montos, fechas y motivos', () => {
    expect(props(CreateRunDto, { period: '2026-9', coverage: 'todas' })).toEqual(['period', 'coverage']);
    expect(props(CreateDeductionDto, { employeeId: 'x', concept: '', amount: 0 })).toEqual([
      'employeeId',
      'concept',
      'amount',
    ]);
    expect(props(LiquidacionDto, { fechaFin: '30/09/2026', motivo: 'despido' })).toEqual(['fechaFin', 'motivo']);
    expect(props(PreviewPayrollDto, { salarioBase: -1 })).toContain('salarioBase');
  });
});
