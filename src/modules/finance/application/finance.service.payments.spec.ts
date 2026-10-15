import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Abonos a cuentas por pagar y por cobrar.
 *
 * Aquí se mueve plata real contra una deuda, y hay dos formas de equivocarse que
 * no dejan rastro:
 *
 * - Abonar de más. Si se aceptara un abono por encima del saldo, la cuenta
 *   quedaría con `paidAmount` mayor que el total y el saldo pendiente saldría
 *   negativo en todos los reportes de cartera.
 * - Cerrar antes de tiempo. El estado sale de comparar abonado contra total; si
 *   un abono parcial marcara la cuenta como pagada, esa deuda desaparece del
 *   listado de pendientes y nadie vuelve a cobrarla.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. Solo se
 * pasan las que usa este camino; el resto van como objetos vacíos, en el orden
 * del constructor:
 *   (categories, expenses, payables, recurring, receivables, accounts,
 *    movements, budgets, sales, products, runs, caja, customers, ledgerPosting,
 *    treasuryPosting, params)
 */
describe('FinanceService · abonos a cuentas por pagar y por cobrar', () => {
  const SEDE = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'tesorera@bookipos.local',
    name: 'Tesorera',
    role: 'manager',
    sedeIds: [SEDE.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let payables: any;
  let receivables: any;
  let ledgerPosting: any;
  let treasuryPosting: any;
  let service: FinanceService;

  /** Cuenta por pagar (o por cobrar) abierta, con su lista de abonos. */
  function cuenta(amount: number, paidAmount = 0) {
    return {
      _id: new Types.ObjectId(),
      sedeId: SEDE,
      amount,
      paidAmount,
      status: paidAmount > 0 ? 'partial' : 'open',
      payments: [] as unknown[],
      docNumber: 'FC-001',
      supplierName: 'Distribuidora',
      customerName: 'Cliente',
      save: vi.fn().mockResolvedValue(undefined),
    };
  }

  /**
   * Simula el update atómico de Mongo: solo casa si la cuenta sigue sin anular
   * y con el mismo abonado que se leyó. `enBase` es el estado real en la base
   * cuando difiere del documento leído.
   */
  function updateAtomico(modelo: () => any, doc: any) {
    return vi.fn((filter: any, update: any) => ({
      exec: () => {
        const actual = modelo().enBase ?? doc;
        if (actual.status === 'void' || actual.paidAmount !== filter.paidAmount) {
          return Promise.resolve(null);
        }
        actual.payments.push(update.$push.payments);
        actual.paidAmount += update.$inc.paidAmount;
        Object.assign(actual, update.$set);
        return Promise.resolve(actual);
      },
    }));
  }

  function build(doc: any) {
    payables = {
      findById: vi.fn(() => ({ exec: () => Promise.resolve(doc) })),
      findOneAndUpdate: updateAtomico(() => payables, doc),
    };
    receivables = {
      findById: vi.fn(() => ({ exec: () => Promise.resolve(doc) })),
      findOneAndUpdate: vi.fn((filter: any, update: any) => ({
        exec: () => {
          const actual = receivables.enBase ?? doc;
          if (
            actual.status === 'void' ||
            actual.paidAmount !== filter.paidAmount
          ) {
            return Promise.resolve(null);
          }
          actual.payments.push(update.$push.payments);
          actual.paidAmount += update.$inc.paidAmount;
          Object.assign(actual, update.$set);
          return Promise.resolve(actual);
        },
      })),
    };
    ledgerPosting = {
      postPayablePayment: vi.fn().mockResolvedValue(undefined),
      postReceivablePayment: vi.fn().mockResolvedValue(undefined),
    };
    treasuryPosting = { post: vi.fn().mockResolvedValue(undefined) };

    service = new FinanceService(
      {} as never,
      {} as never,
      payables as never,
      {} as never,
      receivables as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      ledgerPosting as never,
      treasuryPosting as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return doc;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cuentas por pagar', () => {
    it('un abono parcial deja la cuenta en parcial, no en pagada', async () => {
      const cxp = build(cuenta(1_000_000));

      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-10', amount: 300_000, method: 'cash' } as never,
        user,
      );

      expect(cxp.paidAmount).toBe(300_000);
      expect(cxp.status).toBe('partial');
      expect(cxp.payments).toHaveLength(1);
    });

    it('varios abonos se acumulan y el último la cierra exacta', async () => {
      const cxp = build(cuenta(1_000_000));

      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-10', amount: 400_000, method: 'cash' } as never,
        user,
      );
      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-20', amount: 600_000, method: 'cash' } as never,
        user,
      );

      expect(cxp.paidAmount).toBe(1_000_000);
      expect(cxp.status).toBe('paid');
      expect(cxp.payments).toHaveLength(2);
    });

    it('rechaza un abono mayor al saldo pendiente', async () => {
      const cxp = build(cuenta(1_000_000, 800_000));

      await expect(
        service.addPayablePayment(
          cxp._id.toString(),
          { date: '2026-09-10', amount: 300_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(cxp.paidAmount).toBe(800_000);
      expect(cxp.save).not.toHaveBeenCalled();
    });

    it('rechaza un abono de cero o negativo', async () => {
      const cxp = build(cuenta(1_000_000));

      for (const amount of [0, -50_000]) {
        await expect(
          service.addPayablePayment(
            cxp._id.toString(),
            { date: '2026-09-10', amount, method: 'cash' } as never,
            user,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(cxp.payments).toHaveLength(0);
    });

    it('no admite abonos sobre una cuenta anulada', async () => {
      const cxp = build(cuenta(1_000_000));
      cxp.status = 'void';

      await expect(
        service.addPayablePayment(
          cxp._id.toString(),
          { date: '2026-09-10', amount: 100_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falla claro si la cuenta no existe', async () => {
      build(null);

      await expect(
        service.addPayablePayment(
          new Types.ObjectId().toString(),
          { date: '2026-09-10', amount: 100_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cada abono postea su propio asiento, identificado por su posición', async () => {
      const cxp = build(cuenta(1_000_000));

      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-10', amount: 100_000, method: 'cash' } as never,
        user,
      );
      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-11', amount: 100_000, method: 'cash' } as never,
        user,
      );

      const ids = ledgerPosting.postPayablePayment.mock.calls.map(
        (c: any[]) => c[0].paymentId,
      );
      // Identificadores distintos: si se repitieran, el segundo asiento se
      // descartaría por idempotente y ese abono no quedaría contabilizado.
      expect(new Set(ids).size).toBe(2);
      expect(ids[0]).toBe(`${cxp._id.toString()}:0`);
      expect(ids[1]).toBe(`${cxp._id.toString()}:1`);
    });

    it('el efectivo no toca tesorería: vive en la caja de la sede', async () => {
      const cxp = build(cuenta(1_000_000));

      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-10', amount: 100_000, method: 'cash' } as never,
        user,
      );

      expect(treasuryPosting.post).not.toHaveBeenCalled();
    });

    it('una transferencia sí sale de la cuenta bancaria', async () => {
      const cxp = build(cuenta(1_000_000));

      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-10', amount: 100_000, method: 'transfer' } as never,
        user,
      );

      expect(treasuryPosting.post).toHaveBeenCalledOnce();
      expect(treasuryPosting.post.mock.calls[0][0]).toMatchObject({
        direction: 'out',
        amount: 100_000,
      });
    });

    // Atómico como el de CxC (checklist 1.13): leer, modificar y guardar
    // dejaba que dos abonos simultáneos se pisaran (uno se perdía sin asiento
    // que lo delatara) o que un abono resucitara una CxP recién anulada.
    it('si la CxP se anula entre la lectura y el abono, rechaza y no la resucita', async () => {
      const cxp = build(cuenta(1_000_000));
      payables.enBase = { ...cxp, status: 'void', payments: [] };

      await expect(
        service.addPayablePayment(
          cxp._id.toString(),
          { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(payables.enBase.status).toBe('void');
      expect(payables.enBase.paidAmount).toBe(0);
      expect(cxp.save).not.toHaveBeenCalled();
      expect(ledgerPosting.postPayablePayment).not.toHaveBeenCalled();
    });

    it('si otro abono entró a la vez, rechaza en vez de pisarlo', async () => {
      const cxp = build(cuenta(1_000_000));
      payables.enBase = { ...cxp, paidAmount: 100_000, payments: [{}] };

      await expect(
        service.addPayablePayment(
          cxp._id.toString(),
          { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(payables.enBase.paidAmount).toBe(100_000);
      expect(payables.enBase.payments).toHaveLength(1);
    });

    it('el abono es un update condicionado (no un save del documento leído)', async () => {
      const cxp = build(cuenta(1_000_000));

      await service.addPayablePayment(
        cxp._id.toString(),
        { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
        user,
      );

      const [filtro, update] = payables.findOneAndUpdate.mock.calls[0];
      expect(filtro).toMatchObject({
        _id: cxp._id,
        status: { $ne: 'void' },
        paidAmount: 0,
      });
      expect(update.$inc).toEqual({ paidAmount: 200_000 });
      expect(cxp.save).not.toHaveBeenCalled();
      expect(ledgerPosting.postPayablePayment.mock.calls[0][0].paymentId).toBe(
        `${cxp._id.toString()}:0`,
      );
    });
  });

  describe('cuentas por cobrar', () => {
    it('un abono parcial deja la cartera abierta', async () => {
      const cxc = build(cuenta(500_000));

      await service.addReceivablePayment(
        cxc._id.toString(),
        { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
        user,
      );

      expect(cxc.paidAmount).toBe(200_000);
      expect(cxc.status).toBe('partial');
    });

    it('el abono que completa el total la marca pagada', async () => {
      const cxc = build(cuenta(500_000, 300_000));

      await service.addReceivablePayment(
        cxc._id.toString(),
        { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
        user,
      );

      expect(cxc.paidAmount).toBe(500_000);
      expect(cxc.status).toBe('paid');
    });

    it('rechaza cobrar más de lo que el cliente debe', async () => {
      const cxc = build(cuenta(500_000, 400_000));

      await expect(
        service.addReceivablePayment(
          cxc._id.toString(),
          { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un cobro por transferencia entra a la cuenta bancaria', async () => {
      const cxc = build(cuenta(500_000));

      await service.addReceivablePayment(
        cxc._id.toString(),
        { date: '2026-09-10', amount: 200_000, method: 'transfer' } as never,
        user,
      );

      expect(treasuryPosting.post.mock.calls[0][0]).toMatchObject({
        direction: 'in',
        amount: 200_000,
      });
    });

    it('el abono se redondea a peso entero antes de acumularse', async () => {
      const cxc = build(cuenta(500_000));

      await service.addReceivablePayment(
        cxc._id.toString(),
        { date: '2026-09-10', amount: 199_999.6, method: 'cash' } as never,
        user,
      );

      expect(cxc.paidAmount).toBe(200_000);
      expect(Number.isInteger(cxc.paidAmount)).toBe(true);
    });

    it('si la CxC se anula entre la lectura y el abono, rechaza y no la resucita', async () => {
      const cxc = build(cuenta(500_000));
      // En la base ya está anulada (la anuló una anulación de la venta).
      receivables.enBase = { ...cxc, status: 'void', payments: [] };

      await expect(
        service.addReceivablePayment(
          cxc._id.toString(),
          { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(receivables.enBase.status).toBe('void');
      expect(receivables.enBase.paidAmount).toBe(0);
      expect(cxc.save).not.toHaveBeenCalled();
      expect(ledgerPosting.postReceivablePayment).not.toHaveBeenCalled();
    });

    it('si otro abono entró a la vez, rechaza en vez de pisarlo', async () => {
      const cxc = build(cuenta(500_000));
      receivables.enBase = { ...cxc, paidAmount: 100_000, payments: [{}] };

      await expect(
        service.addReceivablePayment(
          cxc._id.toString(),
          { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
          user,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(receivables.enBase.paidAmount).toBe(100_000);
    });

    it('el abono es un update condicionado (no un save del documento leído)', async () => {
      const cxc = build(cuenta(500_000));

      await service.addReceivablePayment(
        cxc._id.toString(),
        { date: '2026-09-10', amount: 200_000, method: 'cash' } as never,
        user,
      );

      const [filtro] = receivables.findOneAndUpdate.mock.calls[0];
      expect(filtro).toMatchObject({
        _id: cxc._id,
        status: { $ne: 'void' },
        paidAmount: 0,
      });
      expect(cxc.save).not.toHaveBeenCalled();
      expect(ledgerPosting.postReceivablePayment.mock.calls[0][0].paymentId).toBe(
        `${cxc._id.toString()}:0`,
      );
    });
  });
});
