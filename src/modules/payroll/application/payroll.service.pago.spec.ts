import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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

/** Medio y fecha real del pago de la corrida (nómina electrónica, decisión 1 del dueño). */
function armar(status: string) {
  const run: any = {
    _id: new Types.ObjectId(),
    period: '2026-10',
    coverage: 'all',
    status,
    slips: [],
    save: vi.fn(async () => run),
  };
  const runs = { findById: () => ({ exec: async () => run }) };
  const deductions = { find: () => ({ select: () => ({ exec: async () => [] }) }), updateMany: () => ({ exec: async () => ({}) }) };
  const ledgerPosting = { postPayrollRun: vi.fn(async () => undefined) };
  const service = new PayrollService(
    {} as any,
    runs as any,
    {} as any,
    {} as any,
    {} as any,
    deductions as any,
    {} as any,
    {} as any,
    ledgerPosting as any,
    {} as any,
  );
  return { service, run };
}
const owner = { role: 'owner', permissions: [], sedeIds: [], email: 'o@x.co' } as any;
const id = (run: any) => String(run._id);

describe('PayrollService: pago de la nómina', () => {
  it('declararPago guarda medio, fecha y quién lo declaró en una corrida cerrada', async () => {
    const { service, run } = armar('cerrada');
    await service.declararPago(id(run), { medioPago: '47', fechaPago: '2026-10-31' }, owner);
    expect(run.pago).toMatchObject({ medio: '47', fecha: '2026-10-31', declaradoPor: 'o@x.co' });
    expect(run.save).toHaveBeenCalled();
  });

  it('declararPago sobre un borrador o con datos inválidos: 400 sin guardar', async () => {
    const b = armar('borrador');
    await expect(b.service.declararPago(id(b.run), { medioPago: '10', fechaPago: '2026-10-31' }, owner)).rejects.toBeInstanceOf(BadRequestException);
    const c = armar('cerrada');
    await expect(c.service.declararPago(id(c.run), { medioPago: '10', fechaPago: '2026-09-30' }, owner)).rejects.toThrow(/anterior al mes/);
    await expect(c.service.declararPago(id(c.run), { medioPago: '10', fechaPago: '2999-01-01' }, owner)).rejects.toThrow(/futura/);
    expect(c.run.save).not.toHaveBeenCalled();
  });

  it('closeRun con el pago lo guarda; sin pago cierra igual (se declara después)', async () => {
    const a = armar('borrador');
    await a.service.closeRun(id(a.run), owner, { medioPago: '10', fechaPago: '2026-10-31' });
    expect(a.run.status).toBe('cerrada');
    expect(a.run.pago).toMatchObject({ medio: '10', fecha: '2026-10-31' });
    const b = armar('borrador');
    await b.service.closeRun(id(b.run), owner, {});
    expect(b.run.status).toBe('cerrada');
    expect(b.run.pago).toBeUndefined();
  });

  it('closeRun con medio sin fecha (o fecha inválida) no cierra', async () => {
    const a = armar('borrador');
    await expect(a.service.closeRun(id(a.run), owner, { medioPago: '10' })).rejects.toThrow(/medio Y la fecha/);
    await expect(a.service.closeRun(id(a.run), owner, { medioPago: '10', fechaPago: '2026-09-01' })).rejects.toThrow(/anterior/);
    expect(a.run.status).toBe('borrador');
  });
});
