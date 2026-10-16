import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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

import { CajaService } from './caja.service';
import { CajaController } from '../infrastructure/caja.controller';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Ítem 5.2: el turno de caja de punta a punta. Apertura, movimientos, arqueo
 * (con domicilios y propinas en efectivo) y cierre con tolerancia de
 * descuadre. El efectivo esperado es lo que el cajero tiene que entregar: un
 * error aquí es un faltante que se le cobra a una persona.
 */
describe('CajaService · ciclo del turno', () => {
  const sedeId = new Types.ObjectId();
  const SEDE = sedeId.toString();
  const cajero = {
    userId: 'u1',
    email: 'caja@x.co',
    role: 'cashier',
    permissions: ['caja.open', 'caja.close', 'caja.movement'],
    sedeIds: [SEDE],
  } as unknown as JwtUser;
  const gerente = { ...cajero, permissions: [...cajero.permissions, 'caja.sangria'] } as JwtUser;

  const q = <T>(v: T) => ({ exec: () => Promise.resolve(v) });

  let abierta: Record<string, any> | null;
  let ventas: Record<string, any>[];
  let movimientos: Record<string, any>[];
  let cuentasAbiertas: number;
  let tolerancia: number;
  let sessions: any;
  let movementsModel: any;
  let sedes: any;
  let service: CajaService;

  function sesion(over: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(),
      sedeId,
      status: 'open',
      openingAmount: 100_000,
      openedAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  beforeEach(() => {
    abierta = null;
    ventas = [];
    movimientos = [];
    cuentasAbiertas = 0;
    tolerancia = 2000;
    sessions = {
      findOne: vi.fn(() => q(abierta)),
      create: vi.fn(async (doc: unknown) => doc),
      find: vi.fn(() => ({
        sort: () => ({
          exec: () => Promise.resolve(abierta ? [abierta] : []),
          skip: () => ({ limit: () => q(abierta ? [abierta] : []) }),
        }),
      })),
      countDocuments: vi.fn(() => q(abierta ? 1 : 0)),
    };
    movementsModel = {
      create: vi.fn(async (doc: unknown) => doc),
      find: vi.fn(() => ({ sort: () => q(movimientos) })),
    };
    const sales = { find: vi.fn(() => q(ventas)) };
    const orders = { countDocuments: vi.fn(() => q(cuentasAbiertas)) };
    sedes = {
      find: vi.fn(() => ({
        sort: () => ({ select: () => q([{ _id: sedeId, name: 'Centro' }]) }),
        select: () => q([{ _id: sedeId, name: 'Centro' }]),
      })),
    };
    const params = { number: vi.fn(async () => tolerancia) };
    service = new CajaService(
      sessions,
      movementsModel,
      sales as never,
      orders as never,
      sedes,
      params as never,
    );
  });

  describe('apertura', () => {
    it('abre con la base y quién abrió', async () => {
      const s = (await service.open(
        { sedeId: SEDE, openingAmount: 150_000 } as never,
        cajero,
      )) as unknown as Record<string, unknown>;
      expect(s).toMatchObject({ status: 'open', openingAmount: 150_000, openedByEmail: 'caja@x.co' });
    });

    it('no abre dos cajas en la misma sede', async () => {
      abierta = sesion();
      await expect(
        service.open({ sedeId: SEDE, openingAmount: 0 } as never, cajero),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('dos aperturas simultáneas: la que choca con el índice único da 409', async () => {
      sessions.create.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));
      await expect(
        service.open({ sedeId: SEDE, openingAmount: 0 } as never, cajero),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('movimientos', () => {
    it('sin caja abierta no hay movimientos', async () => {
      await expect(
        service.movement({ sedeId: SEDE, type: 'in', amount: 1000 } as never, cajero),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('registra el movimiento en el turno abierto', async () => {
      abierta = sesion();
      const m = (await service.movement(
        { sedeId: SEDE, type: 'out', amount: 5000, reason: 'hielo' } as never,
        cajero,
      )) as unknown as Record<string, unknown>;
      expect(m).toMatchObject({ sessionId: abierta._id, type: 'out', amount: 5000 });
    });

    it('la sangría exige su propio permiso', async () => {
      abierta = sesion();
      await expect(
        service.movement({ sedeId: SEDE, type: 'sangria', amount: 50_000 } as never, cajero),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.movement({ sedeId: SEDE, type: 'sangria', amount: 50_000 } as never, gerente),
      ).resolves.toBeTruthy();
    });
  });

  describe('arqueo y cierre', () => {
    beforeEach(() => {
      abierta = sesion();
      ventas = [
        // Efectivo con propina y domicilio: los dos entran al cajón.
        { total: 40_000, tip: 4_000, deliveryFee: 5_000, payment: { method: 'cash' } },
        { total: 30_000, payment: { method: 'cash' } },
        // Tarjeta: cuenta en ventas, no en efectivo.
        { total: 60_000, tip: 6_000, payment: { method: 'card' } },
      ];
      movimientos = [
        { type: 'in', amount: 20_000 },
        { type: 'out', amount: 7_000 },
        { type: 'sangria', amount: 50_000 },
      ];
    });

    // 100.000 base + 79.000 efectivo + 20.000 entradas − 57.000 salidas.
    const ESPERADO = 142_000;

    it('el efectivo esperado suma base, ventas en efectivo con propina y domicilio, y movimientos', async () => {
      const { totals } = await service.current(SEDE, cajero);
      expect(totals).toEqual({
        salesCount: 3,
        salesTotal: 130_000,
        cashSalesTotal: 79_000,
        movementsIn: 20_000,
        movementsOut: 57_000,
        expectedCash: ESPERADO,
      });
    });

    it('cierra cuadrado y congela los totales del turno', async () => {
      const s = (await service.close(
        { sedeId: SEDE, countedAmount: ESPERADO } as never,
        cajero,
      )) as unknown as Record<string, unknown>;
      expect(s).toMatchObject({
        status: 'closed',
        expectedCash: ESPERADO,
        difference: 0,
        withinTolerance: true,
        salesTotal: 130_000,
        closedByEmail: 'caja@x.co',
      });
      expect(abierta!.save).toHaveBeenCalledOnce();
    });

    it('un descuadre dentro de la tolerancia cierra sin nota', async () => {
      const s = (await service.close(
        { sedeId: SEDE, countedAmount: ESPERADO - 1500 } as never,
        cajero,
      )) as unknown as Record<string, unknown>;
      expect(s).toMatchObject({ difference: -1500, withinTolerance: true, toleranceApplied: 2000 });
    });

    it('un descuadre mayor exige nota; con nota cierra marcado fuera de tolerancia', async () => {
      await expect(
        service.close({ sedeId: SEDE, countedAmount: ESPERADO - 10_000 } as never, cajero),
      ).rejects.toBeInstanceOf(BadRequestException);
      const s = (await service.close(
        { sedeId: SEDE, countedAmount: ESPERADO - 10_000, note: 'faltó un billete' } as never,
        cajero,
      )) as unknown as Record<string, unknown>;
      expect(s).toMatchObject({ difference: -10_000, withinTolerance: false, closeNote: 'faltó un billete' });
    });

    it('no cierra con cuentas de restaurante abiertas', async () => {
      cuentasAbiertas = 2;
      await expect(
        service.close({ sedeId: SEDE, countedAmount: ESPERADO } as never, cajero),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('no cierra si no hay caja abierta', async () => {
      abierta = null;
      await expect(
        service.close({ sedeId: SEDE, countedAmount: 0 } as never, cajero),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reportes', () => {
    it('el resumen del día muestra la sede sin apertura', async () => {
      const o = await service.overview(cajero, '2026-10-15');
      expect(o.rows).toEqual([expect.objectContaining({ status: 'none', sedeName: 'Centro' })]);
      expect(o.totals).toMatchObject({ sedes: 1, noneCount: 1, openCount: 0 });
    });

    it('el resumen usa totales en vivo de la abierta y congelados de la cerrada', async () => {
      abierta = sesion();
      ventas = [{ total: 10_000, payment: { method: 'cash' } }];
      const vivo = await service.overview(cajero);
      expect(vivo.rows[0]).toMatchObject({ status: 'open', expectedCash: 110_000 });

      abierta = sesion({
        status: 'closed',
        salesCount: 4,
        salesTotal: 80_000,
        cashSalesTotal: 50_000,
        movementsIn: 0,
        movementsOut: 0,
        expectedCash: 150_000,
        countedAmount: 149_000,
        difference: -1000,
      });
      const cerrado = await service.overview(cajero);
      expect(cerrado.rows[0]).toMatchObject({ status: 'closed', expectedCash: 150_000, difference: -1000 });
      expect(cerrado.totals).toMatchObject({ closedCount: 1, salesTotal: 80_000 });
    });

    it('el efectivo en vivo suma los cajones abiertos', async () => {
      expect(await service.liveCash(cajero)).toEqual({ rows: [], total: 0 });
      abierta = sesion();
      ventas = [{ total: 25_000, payment: { method: 'cash' } }];
      const vivo = await service.liveCash(cajero, SEDE);
      expect(vivo.total).toBe(125_000);
      expect(vivo.rows[0]).toMatchObject({ sedeName: 'Centro', expectedCash: 125_000 });
    });

    it('los cierres del rango suman lo contado y el descuadre', async () => {
      abierta = sesion({
        status: 'closed',
        closedAt: new Date(),
        expectedCash: 200_000,
        countedAmount: 198_000,
        difference: -2000,
        salesTotal: 90_000,
      });
      const r = await service.closings(cajero, { from: '2026-10-01', to: '2026-10-15' });
      expect(r).toMatchObject({ from: '2026-10-01', to: '2026-10-15' });
      expect(r.totals).toEqual({
        count: 1,
        openingTotal: 100_000,
        salesTotal: 90_000,
        expectedCash: 200_000,
        countedAmount: 198_000,
        difference: -2000,
      });
    });

    it('el historial pagina con límites sanos', async () => {
      abierta = sesion();
      const h = await service.history(SEDE, cajero, 0, 500);
      expect(h).toMatchObject({ total: 1, page: 1, limit: 100 });
    });
  });

  describe('controlador', () => {
    it('exige la sede y pasa los parámetros al servicio', async () => {
      const c = new CajaController(service);
      expect(() => c.current('', cajero)).toThrow(BadRequestException);
      expect(() => c.history(cajero, '')).toThrow(BadRequestException);
      abierta = sesion();
      await expect(c.history(cajero, SEDE, '2', '10')).resolves.toMatchObject({ page: 2, limit: 10 });
      await expect(c.current(SEDE, cajero)).resolves.toMatchObject({ session: abierta });
      await expect(c.overview(cajero)).resolves.toBeTruthy();
      await expect(c.closings(cajero)).resolves.toBeTruthy();
      abierta = null;
      await expect(c.open({ sedeId: SEDE, openingAmount: 0 } as never, cajero)).resolves.toBeTruthy();
      abierta = sesion();
      await expect(
        c.movement({ sedeId: SEDE, type: 'in', amount: 1 } as never, cajero),
      ).resolves.toBeTruthy();
      await expect(
        c.close({ sedeId: SEDE, countedAmount: 100_000 } as never, cajero),
      ).resolves.toBeTruthy();
    });
  });
});
