import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { ACC, SEED_ACCOUNTS } from '../domain/ledger.constants';
import type { PostLine } from './ledger.service';

/**
 * Ítem 7.5: pedidos de plataformas de domicilio. La plataforma cobra al cliente
 * y liquida después: el pedido es CxC (1305), no Caja ni Bancos, y la comisión
 * es gasto al liquidar. Ambos asientos tienen que salir cuadrados.
 */
describe('LedgerPostingService · plataformas de domicilio', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let ledger: any;
  let service: LedgerPostingService;

  const lines = (): PostLine[] => ledger.post.mock.calls.at(-1)?.[0].lines ?? [];
  const side = (w: 'debit' | 'credit') => lines().reduce((s, l) => s + (l[w] ?? 0), 0);
  const on = (code: string, w: 'debit' | 'credit') =>
    lines().filter((l) => l.accountCode === code).reduce((s, l) => s + (l[w] ?? 0), 0);

  beforeEach(() => {
    ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue({}),
      reverseBySource: vi.fn().mockResolvedValue({}),
    };
    service = new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never);
  });

  it('la cuenta de comisiones existe en el plan sembrado', () => {
    expect(SEED_ACCOUNTS.some((a) => a.code === ACC.COMISIONES_PLATAFORMAS)).toBe(true);
  });

  describe('venta de plataforma', () => {
    it('el total + domicilio va a Clientes (1305), no a Caja ni Bancos, y cuadra', async () => {
      await service.postSale({
        saleId: 's1',
        number: 'FV-000010',
        date: '2026-10-10',
        sedeId: SEDE,
        total: 59_500,
        tax: 9_500,
        cogs: 20_000,
        deliveryFee: 3_000,
        paymentMethod: 'platform',
      });

      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.CLIENTES, 'debit')).toBe(62_500);
      expect(on(ACC.CAJA, 'debit')).toBe(0);
      expect(on(ACC.BANCOS, 'debit')).toBe(0);
      expect(on(ACC.INGRESOS_VENTAS, 'credit')).toBe(53_000);
    });
  });

  describe('liquidación', () => {
    const base = { settlementId: 'l1', platformLabel: 'Rappi', date: '2026-10-17', sedeId: SEDE };

    it('consignado + comisión = bruto: cuadra y cancela la CxC', async () => {
      await service.postPlatformSettlement({
        ...base,
        gross: 200_000,
        received: 150_000,
        commission: 50_000,
      });

      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.CLIENTES, 'credit')).toBe(200_000);
      expect(on(ACC.BANCOS, 'debit')).toBe(150_000);
      expect(on(ACC.COMISIONES_PLATAFORMAS, 'debit')).toBe(50_000);
      // Nada de esto toca Caja: no entra al arqueo.
      expect(on(ACC.CAJA, 'debit') + on(ACC.CAJA, 'credit')).toBe(0);
    });

    it('con IVA de la comisión lo debita en la 2408 y sigue cuadrando', async () => {
      await service.postPlatformSettlement({
        ...base,
        gross: 100_000,
        received: 70_000,
        commission: 25_210,
        commissionIva: 4_790,
        ivaDescontable: true,
      });

      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.IVA_POR_PAGAR, 'debit')).toBe(4_790);
      expect(on(ACC.COMISIONES_PLATAFORMAS, 'debit')).toBe(25_210);
    });

    it('sin comisión no deja renglones en cero', async () => {
      await service.postPlatformSettlement({ ...base, gross: 80_000, received: 80_000, commission: 0 });

      expect(lines().every((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0)).toBe(true);
      expect(side('debit')).toBe(side('credit'));
    });

    it('es idempotente por (platform_settlement, id): si ya existe no postea otra vez', async () => {
      ledger.findBySource.mockResolvedValue({ _id: 'x' });
      await service.postPlatformSettlement({ ...base, gross: 10_000, received: 8_000, commission: 2_000 });
      expect(ledger.post).not.toHaveBeenCalled();
    });

    it('IVA de la comisión NO descontable (no responsable / INC): va como mayor valor del gasto en la 5235', async () => {
      await service.postPlatformSettlement({
        ...base,
        gross: 100_000,
        received: 70_000,
        commission: 25_210,
        commissionIva: 4_790,
        ivaDescontable: false,
      });
      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.IVA_POR_PAGAR, 'debit')).toBe(0);
      expect(on(ACC.COMISIONES_PLATAFORMAS, 'debit')).toBe(30_000);
    });

    it('retenciones que practica la plataforma: anticipos 135515/135517/135518 dentro del cuadre', async () => {
      await service.postPlatformSettlement({
        ...base,
        gross: 100_000,
        received: 66_000,
        commission: 30_000,
        retefuente: 2_000,
        reteIca: 700,
        reteIva: 1_300,
      });
      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.RETEFUENTE_A_FAVOR, 'debit')).toBe(2_000);
      expect(on(ACC.RETEICA_A_FAVOR, 'debit')).toBe(700);
      expect(on(ACC.RETEIVA_A_FAVOR, 'debit')).toBe(1_300);
    });

    it('ajuste de precio positivo (la plataforma cobró más): crédito a la 4295', async () => {
      await service.postPlatformSettlement({
        ...base,
        gross: 100_000,
        received: 90_000,
        commission: 15_000,
        ajustePrecio: 5_000,
      });
      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.MAYOR_VALOR_PLATAFORMAS, 'credit')).toBe(5_000);
      expect(on(ACC.CLIENTES, 'credit')).toBe(100_000);
    });

    it('ajuste de precio negativo (la plataforma cobró menos): débito a la 5235', async () => {
      await service.postPlatformSettlement({
        ...base,
        gross: 100_000,
        received: 80_000,
        commission: 15_000,
        ajustePrecio: -5_000,
      });
      expect(side('debit')).toBe(side('credit'));
      expect(on(ACC.COMISIONES_PLATAFORMAS, 'debit')).toBe(20_000);
      expect(on(ACC.MAYOR_VALOR_PLATAFORMAS, 'credit')).toBe(0);
    });

    it('si la reversa falla, el error SUBE (no se traga como pendiente)', async () => {
      ledger.reverseBySource.mockRejectedValue(new Error('libro caído'));
      await expect(service.reversePlatformSettlement('l1')).rejects.toThrow(/libro caído/);
    });

    it('la reversa usa el mismo origen', async () => {
      await service.reversePlatformSettlement('l1', 'a@b.co');
      expect(ledger.reverseBySource).toHaveBeenCalledWith('platform_settlement', 'l1', 'a@b.co');
    });
  });
});
