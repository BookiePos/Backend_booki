import { describe, it, expect, vi, beforeEach } from 'vitest';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas (aquí llegan por la cadena
// de imports del servicio). Mismo patrón que el resto de las pruebas.
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

import { LedgerPostingService } from './ledger-posting.service';
import { ACC } from '../domain/ledger.constants';
import type { PostLine } from './ledger.service';

/**
 * Todo asiento automático tiene que salir CUADRADO.
 *
 * Es el invariante que sostiene la contabilidad entera: si un evento de negocio
 * postea débitos distintos de créditos, el balance de comprobación deja de
 * cuadrar y ningún reporte vuelve a ser confiable. `LedgerService.post` lo
 * rechaza, pero ese rechazo se traga en `safePost` como warning —a propósito,
 * para no tumbar la venta—, así que un descuadre no se ve por ninguna parte:
 * simplemente el asiento no existe y los reportes salen cortos en silencio.
 *
 * Por eso se comprueba aquí, en el que ARMA los renglones, y para cada tipo de
 * evento que mueve dinero.
 */
describe('LedgerPostingService · asientos automáticos', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';

  let ledger: any;
  let service: LedgerPostingService;

  /** Renglones del último asiento posteado. */
  function lines(): PostLine[] {
    return ledger.post.mock.calls.at(-1)?.[0].lines ?? [];
  }

  /** Suma de un lado del asiento. */
  function side(which: 'debit' | 'credit'): number {
    return lines().reduce((sum, l) => sum + (l[which] ?? 0), 0);
  }

  /** Monto cargado a una cuenta por un lado concreto. */
  function amountOn(code: string, which: 'debit' | 'credit'): number {
    return lines()
      .filter((l) => l.accountCode === code)
      .reduce((sum, l) => sum + (l[which] ?? 0), 0);
  }

  beforeEach(() => {
    ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue({}),
      reverseBySource: vi.fn().mockResolvedValue({}),
    };
    service = new LedgerPostingService(ledger as never);
  });

  describe('venta', () => {
    // El DTO de venta exige método de pago, así que nunca llega sin él.
    const base = {
      saleId: 's1',
      number: 'FV-000001',
      date: '2026-09-10',
      sedeId: SEDE,
      paymentMethod: 'cash',
    };

    it('cuadra: el total debitado vuelve como ingreso más IVA', async () => {
      await service.postSale({ ...base, total: 119_000, tax: 19_000, cogs: 0 });

      expect(side('debit')).toBe(side('credit'));
      expect(amountOn(ACC.CAJA, 'debit')).toBe(119_000);
      expect(amountOn(ACC.INGRESOS_VENTAS, 'credit')).toBe(100_000);
      expect(amountOn(ACC.IVA_POR_PAGAR, 'credit')).toBe(19_000);
    });

    it('con costo de venta sigue cuadrando: sale de inventario y entra al costo', async () => {
      await service.postSale({
        ...base,
        total: 119_000,
        tax: 19_000,
        cogs: 60_000,
      });

      expect(side('debit')).toBe(side('credit'));
      expect(amountOn(ACC.COSTO_VENTA, 'debit')).toBe(60_000);
      expect(amountOn(ACC.INVENTARIO, 'credit')).toBe(60_000);
    });

    it('sin IVA no abre el renglón de impuesto y el ingreso es el total', async () => {
      await service.postSale({ ...base, total: 50_000, tax: 0, cogs: 0 });

      expect(side('debit')).toBe(side('credit'));
      expect(amountOn(ACC.INGRESOS_VENTAS, 'credit')).toBe(50_000);
      expect(lines().some((l) => l.accountCode === ACC.IVA_POR_PAGAR)).toBe(
        false,
      );
    });

    it('fiado va a Clientes, no a Caja: la plata todavía no entró', async () => {
      await service.postSale({
        ...base,
        total: 80_000,
        tax: 0,
        cogs: 0,
        onCredit: true,
        paymentMethod: 'cash',
      });

      expect(amountOn(ACC.CLIENTES, 'debit')).toBe(80_000);
      expect(amountOn(ACC.CAJA, 'debit')).toBe(0);
    });

    it('lo que no es efectivo entra por Bancos', async () => {
      await service.postSale({
        ...base,
        total: 80_000,
        tax: 0,
        cogs: 0,
        paymentMethod: 'card',
      });

      expect(amountOn(ACC.BANCOS, 'debit')).toBe(80_000);
      expect(amountOn(ACC.CAJA, 'debit')).toBe(0);
    });

    it('cuadra también con importes que no dividen exacto', async () => {
      // 17.849 con IVA del 19% incluido: los redondeos no pueden abrir hueco.
      await service.postSale({
        ...base,
        total: 17_849,
        tax: 2_850,
        cogs: 4_133,
      });

      expect(side('debit')).toBe(side('credit'));
    });
  });

  describe('gasto', () => {
    const base = {
      expenseId: 'e1',
      date: '2026-09-10',
      sedeId: SEDE,
      concept: 'Arriendo',
    };

    it('pagado: el gasto es base más impuesto y sale de la caja', async () => {
      await service.postExpense({
        ...base,
        amount: 1_000_000,
        tax: 190_000,
        status: 'paid',
        paymentMethod: 'cash',
      });

      expect(side('debit')).toBe(side('credit'));
      expect(side('debit')).toBe(1_190_000);
      expect(amountOn(ACC.CAJA, 'credit')).toBe(1_190_000);
    });

    it('por pagar: queda debiéndose a Proveedores, no sale plata', async () => {
      await service.postExpense({
        ...base,
        amount: 1_000_000,
        tax: 0,
        status: 'payable',
        paymentMethod: 'cash',
      });

      expect(amountOn(ACC.PROVEEDORES, 'credit')).toBe(1_000_000);
      expect(amountOn(ACC.CAJA, 'credit')).toBe(0);
    });

    it('sin cuenta de gasto indicada cae en gastos diversos', async () => {
      await service.postExpense({
        ...base,
        amount: 5_000,
        tax: 0,
        status: 'paid',
      });

      expect(amountOn(ACC.GASTOS_DIVERSOS, 'debit')).toBe(5_000);
    });
  });

  describe('abonos', () => {
    it('pago a proveedor: baja la deuda y sale el dinero, cuadrado', async () => {
      await service.postPayablePayment({
        paymentId: 'p1',
        date: '2026-09-10',
        sedeId: SEDE,
        amount: 300_000,
        paymentMethod: 'transfer',
      });

      expect(side('debit')).toBe(side('credit'));
      expect(amountOn(ACC.PROVEEDORES, 'debit')).toBe(300_000);
      expect(amountOn(ACC.BANCOS, 'credit')).toBe(300_000);
    });

    it('cobro a cliente: entra el dinero y baja la cartera, cuadrado', async () => {
      await service.postReceivablePayment({
        paymentId: 'c1',
        date: '2026-09-10',
        sedeId: SEDE,
        amount: 300_000,
        paymentMethod: 'cash',
      });

      expect(side('debit')).toBe(side('credit'));
      expect(amountOn(ACC.CAJA, 'debit')).toBe(300_000);
      expect(amountOn(ACC.CLIENTES, 'credit')).toBe(300_000);
    });
  });

  describe('compra y nómina', () => {
    it('recepción de compra a crédito: entra inventario, sube la deuda', async () => {
      await service.postPurchaseReceipt({
        receiptId: 'r1',
        date: '2026-09-10',
        sedeId: SEDE,
        amount: 2_500_000,
        onCredit: true,
        number: 'OC-000004',
      });

      expect(side('debit')).toBe(side('credit'));
      expect(amountOn(ACC.INVENTARIO, 'debit')).toBe(2_500_000);
      expect(amountOn(ACC.PROVEEDORES, 'credit')).toBe(2_500_000);
    });

    it('nómina causada: gasto de personal contra salarios por pagar', async () => {
      await service.postPayrollRun({
        runId: 'n1',
        date: '2026-09-30',
        sedeId: SEDE,
        amount: 4_800_000,
        period: '2026-09',
      });

      expect(side('debit')).toBe(side('credit'));
      expect(amountOn(ACC.GASTOS_PERSONAL, 'debit')).toBe(4_800_000);
      expect(amountOn(ACC.SALARIOS_POR_PAGAR, 'credit')).toBe(4_800_000);
    });

    it('no postea asientos en cero (recepción o nómina sin monto)', async () => {
      await service.postPurchaseReceipt({
        receiptId: 'r0',
        date: '2026-09-10',
        sedeId: SEDE,
        amount: 0,
        onCredit: true,
        number: 'OC-000005',
      });
      await service.postPayrollRun({
        runId: 'n0',
        date: '2026-09-30',
        amount: 0,
        period: '2026-09',
      });

      expect(ledger.post).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia y tolerancia a fallos', () => {
    it('no vuelve a postear un evento que ya tiene asiento', async () => {
      ledger.findBySource.mockResolvedValue({ number: 'AS-000001' });

      await service.postSale({
        saleId: 's1',
        number: 'FV-000001',
        date: '2026-09-10',
        sedeId: SEDE,
        total: 10_000,
        tax: 0,
        cogs: 0,
      });

      expect(ledger.post).not.toHaveBeenCalled();
    });

    it('si el ledger falla, la operación de negocio no se cae', async () => {
      // Decisión deliberada: la venta es la fuente de verdad y el asiento se
      // puede reconstruir. Se fija para que nadie lo convierta en un throw.
      ledger.post.mockRejectedValue(new Error('ledger caído'));

      await expect(
        service.postSale({
          saleId: 's1',
          number: 'FV-000001',
          date: '2026-09-10',
          sedeId: SEDE,
          total: 10_000,
          tax: 0,
          cogs: 0,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
