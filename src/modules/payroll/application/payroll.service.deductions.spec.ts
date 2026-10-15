import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

// Mismo patrón que las pruebas de ventas: SWC emite `Object` como metadata de
// los @Prop() con uniones de literales y @nestjs/mongoose revienta al importar
// los esquemas. Los modelos van mockeados, así que se neutralizan.
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

/**
 * Anular un fiado de empleado (checklist 1.6): el consumo POS que la venta dejó
 * en nómina se cancela mientras no se haya descontado. Si ya entró en una
 * corrida (`applied`), la anulación se rechaza: el dinero ya salió de la
 * colilla y devolverlo es un ajuste de nómina, no un cambio de estado.
 *
 * Constructor (orden):
 *   settings, runs, employees, attendance, sedes, deductions, mail, params,
 *   ledgerPosting
 */
describe('PayrollService.cancelSaleDeduction', () => {
  const SALE = 'venta-1';
  let deductions: any;
  let service: PayrollService;

  function con(aplicada: unknown) {
    deductions = {
      findOne: vi.fn().mockReturnValue({ exec: () => Promise.resolve(aplicada) }),
      updateMany: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    service = new PayrollService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      deductions,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  beforeEach(() => con(null));

  it('cancela el consumo pendiente o aprobado de esa venta', async () => {
    await service.cancelSaleDeduction(SALE);

    expect(deductions.updateMany).toHaveBeenCalledWith(
      {
        source: 'sale',
        sourceId: SALE,
        status: { $in: ['pending', 'approved'] },
      },
      { $set: { status: 'cancelled' } },
    );
  });

  it('si ya se descontó en una nómina, rechaza y no toca nada', async () => {
    con({ status: 'applied', appliedPeriod: '2026-09', amount: 16_900 });

    await expect(service.cancelSaleDeduction(SALE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(deductions.updateMany).not.toHaveBeenCalled();
  });

  it('si una corrida lo aplica a la vez (updateMany no lo toma), rechaza', async () => {
    // Primera mirada: nada aplicado. Tras el updateMany: la corrida ya lo tomó.
    deductions.findOne
      .mockReturnValueOnce({ exec: () => Promise.resolve(null) })
      .mockReturnValueOnce({
        exec: () => Promise.resolve({ status: 'applied', appliedPeriod: '2026-10' }),
      });
    deductions.updateMany.mockReturnValue({
      exec: () => Promise.resolve({ modifiedCount: 0 }),
    });

    await expect(service.cancelSaleDeduction(SALE)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('restoreSaleDeduction devuelve el consumo cancelado a pendiente', async () => {
    await service.restoreSaleDeduction(SALE);

    expect(deductions.updateMany).toHaveBeenCalledWith(
      { source: 'sale', sourceId: SALE, status: 'cancelled' },
      { $set: { status: 'pending' } },
    );
  });
});

/**
 * Lado de la corrida: si un consumo leído como aprobado se anuló (o lo tomó
 * otra corrida) antes de marcarlo aplicado, la colilla lo estaría descontando
 * sin que la deducción quede amarrada a la corrida.
 */
describe('PayrollService.applyDeductionsToRun', () => {
  const runId = new Types.ObjectId();
  const ids = [new Types.ObjectId(), new Types.ObjectId()];

  function servicio(matchedCount: number) {
    const deductions = {
      updateMany: vi
        .fn()
        .mockReturnValueOnce({ exec: () => Promise.resolve({ matchedCount }) })
        .mockReturnValue({ exec: () => Promise.resolve({ modifiedCount: 1 }) }),
    };
    const service = new PayrollService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      deductions as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service: service as any, deductions };
  }

  it('todas tomadas: no deshace nada', async () => {
    const { service, deductions } = servicio(2);
    await service.applyDeductionsToRun(ids, runId, '2026-10');
    expect(deductions.updateMany).toHaveBeenCalledTimes(1);
  });

  it('alguna se escapó: suelta las que tomó esta corrida y lanza 409', async () => {
    const { service, deductions } = servicio(1);

    await expect(
      service.applyDeductionsToRun(ids, runId, '2026-10'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(deductions.updateMany).toHaveBeenLastCalledWith(
      { appliedRunId: runId },
      {
        $set: { status: 'approved' },
        $unset: { appliedRunId: '', appliedPeriod: '' },
      },
    );
  });
});
