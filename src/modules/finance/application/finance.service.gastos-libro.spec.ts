import { describe, it, expect, vi } from 'vitest';
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

import { FinanceService } from './finance.service';
import { ACC } from '../../core-ledger/domain/ledger.constants';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Editar o borrar un gasto tiene que mover el libro (checklist 1.13). Antes
 * `updateExpense` y `deleteExpense` solo tocaban tesorería: un gasto de
 * $100.000 corregido a $80.000 seguía pesando $100.000 en el balance, y uno
 * borrado seguía ahí para siempre. El asiento no se edita: se reversa y, si el
 * gasto sigue vivo, se postea otro con los datos nuevos.
 *
 * Constructor (orden): categories, expenses, payables, recurring, receivables,
 * accounts, movements, budgets, sales, products, runs, caja, customers,
 * ledgerPosting, treasuryPosting, params, sedes, businesses, ledger.
 */
describe('FinanceService · editar o borrar un gasto mueve el libro', () => {
  const SEDE = new Types.ObjectId();
  const CAT = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'duena@bookipos.local',
    role: 'owner',
    sedeIds: [SEDE.toString()],
    permissions: [],
  } as unknown as JwtUser;

  const q = (doc: unknown) => ({
    select: () => ({ exec: () => Promise.resolve(doc) }),
    exec: () => Promise.resolve(doc),
  });

  function build() {
    const gasto: any = {
      _id: new Types.ObjectId(),
      sedeId: SEDE,
      categoryId: CAT,
      categoryName: 'Servicios',
      concept: 'Internet',
      amount: 100_000,
      taxAmount: 0,
      withholdingAmount: 0,
      date: '2026-10-10',
      status: 'paid',
      paymentMethod: 'cash',
      save: vi.fn().mockResolvedValue(undefined),
      deleteOne: vi.fn().mockResolvedValue(undefined),
    };
    const ledgerPosting = {
      postExpense: vi.fn().mockResolvedValue(undefined),
      reverseExpense: vi.fn().mockResolvedValue(undefined),
    };
    const args: unknown[] = Array.from({ length: 19 }, () => ({}));
    args[0] = { findById: vi.fn(() => q({ _id: CAT, name: 'Servicios', kind: 'expense' })) };
    args[1] = { findById: vi.fn(() => q(gasto)) };
    args[13] = ledgerPosting;
    args[14] = { post: vi.fn(), reverse: vi.fn() };
    args[16] = { find: vi.fn(() => q([{ _id: SEDE, responsabilidadFiscal: 'responsable_iva' }])) };
    args[17] = { findById: async () => null };
    const service = new (FinanceService as any)(...args) as FinanceService;
    const run = <T>(fn: () => Promise<T>) =>
      TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'retail' }, fn);
    return { gasto, ledgerPosting, service, run };
  }

  it('al cambiar el monto, reversa el asiento y postea el nuevo con los datos editados', async () => {
    const { gasto, ledgerPosting, service, run } = build();

    await run(() =>
      service.updateExpense(gasto._id.toString(), { amount: 80_000, taxAmount: 15_200 } as never, user),
    );

    expect(ledgerPosting.reverseExpense).toHaveBeenCalledWith(gasto._id.toString(), user.email);
    expect(ledgerPosting.postExpense).toHaveBeenCalledOnce();
    expect(ledgerPosting.postExpense.mock.calls[0]![0]).toMatchObject({
      expenseId: gasto._id.toString(),
      sedeId: SEDE.toString(),
      amount: 80_000,
      tax: 15_200,
      ivaDescontable: 15_200,
      status: 'paid',
      paymentMethod: 'cash',
      date: '2026-10-10',
      withholding: 0,
    });
    // Primero la reversa, después el nuevo: si fuera al revés, el índice de
    // un asiento vivo por origen tomaría el nuevo por «ya posteado».
    expect(ledgerPosting.reverseExpense.mock.invocationCallOrder[0]!).toBeLessThan(
      ledgerPosting.postExpense.mock.invocationCallOrder[0]!,
    );
  });

  it('pasar de pagado a por pagar también re-postea (cambia la contrapartida)', async () => {
    const { gasto, ledgerPosting, service, run } = build();

    await run(() => service.updateExpense(gasto._id.toString(), { status: 'payable' } as never, user));

    expect(ledgerPosting.reverseExpense).toHaveBeenCalledOnce();
    expect(ledgerPosting.postExpense.mock.calls[0]![0].status).toBe('payable');
  });

  it('una edición que no toca el libro (nota, proveedor) no reversa nada', async () => {
    const { gasto, ledgerPosting, service, run } = build();

    await run(() =>
      service.updateExpense(gasto._id.toString(), { note: 'factura 123', amount: 100_000 } as never, user),
    );

    expect(ledgerPosting.reverseExpense).not.toHaveBeenCalled();
    expect(ledgerPosting.postExpense).not.toHaveBeenCalled();
  });

  it('la categoría de nómina lleva el gasto a la cuenta de personal', async () => {
    const { gasto, ledgerPosting, service, run } = build();
    const NOMINA = new Types.ObjectId();
    (service as any).categories.findById = vi.fn(() =>
      q({ _id: NOMINA, name: 'Nómina', kind: 'payroll' }),
    );

    await run(() =>
      service.updateExpense(gasto._id.toString(), { categoryId: NOMINA.toString() } as never, user),
    );

    expect(ledgerPosting.postExpense.mock.calls[0]![0].expenseAccount).toBe(ACC.GASTOS_PERSONAL);
  });

  it('borrar el gasto reversa su asiento', async () => {
    const { gasto, ledgerPosting, service, run } = build();

    await run(() => service.deleteExpense(gasto._id.toString(), user));

    expect(gasto.deleteOne).toHaveBeenCalledOnce();
    expect(ledgerPosting.reverseExpense).toHaveBeenCalledWith(gasto._id.toString(), user.email);
    expect(ledgerPosting.postExpense).not.toHaveBeenCalled();
  });
});
