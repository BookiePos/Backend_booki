import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata de tipo para los @Prop() con uniones de
// literales, y @nestjs/mongoose lanza al no poder inferir el tipo cuando se
// importan los esquemas. Estos tests no usan los esquemas reales (modelos
// mockeados): neutralizamos decoradores/SchemaFactory para importar el servicio.
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
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Aritmética del arqueo de caja: CajaService.summarize.
 *
 * `summarize` es privado; se ejercita a través del método público `current`,
 * que llama a `findOpen` (sessions.findOne...exec) y luego a `summarize`
 * (sales.find...exec + movements.find...sort...exec). Inyectamos los totales
 * mockeando el resultado de esas consultas y validamos la fórmula:
 *   expectedCash = openingAmount + cashSalesTotal + movementsIn − movementsOut
 *
 * Constructor (orden): (sessions, movements, sales, orders, sedes, params)
 */
describe('CajaService.summarize (aritmética del arqueo)', () => {
  const sedeId = new Types.ObjectId();
  const sessionObjId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@erp.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  const openingAmount = 100_000;

  // Sesión abierta devuelta por findOpen (findOne...exec).
  function openSession() {
    return {
      _id: sessionObjId,
      sedeId,
      status: 'open',
      openingAmount,
    };
  }

  let sessions: any;
  let movements: any;
  let sales: any;
  let service: CajaService;

  // Configura los resultados de sales.find(...).exec() y movements.find(...).sort(...).exec()
  function wire(saleDocs: any[], movementDocs: any[]) {
    sales = {
      find: vi.fn().mockReturnValue({ exec: () => Promise.resolve(saleDocs) }),
    };
    movements = {
      find: vi.fn().mockReturnValue({
        sort: () => ({ exec: () => Promise.resolve(movementDocs) }),
      }),
    };
    sessions = {
      findOne: vi
        .fn()
        .mockReturnValue({ exec: () => Promise.resolve(openSession()) }),
    };
    service = new CajaService(
      sessions, // sessions
      movements, // movements
      sales, // sales
      {} as any, // orders
      {} as any, // sedes
      {} as any, // params
    );
  }

  beforeEach(() => {
    wire([], []);
  });

  it('expectedCash = base + ventas efectivo + entradas − salidas', async () => {
    const saleDocs = [
      { total: 50_000, tip: 0, payment: { method: 'cash' } },
      { total: 30_000, tip: 0, payment: { method: 'cash' } },
    ];
    const movementDocs = [
      { type: 'in', amount: 20_000 },
      { type: 'out', amount: 5_000 },
    ];
    wire(saleDocs, movementDocs);

    const { totals } = await service.current(sedeId.toString(), user);

    // cashSalesTotal = 50k + 30k = 80k
    expect(totals!.cashSalesTotal).toBe(80_000);
    expect(totals!.movementsIn).toBe(20_000);
    expect(totals!.movementsOut).toBe(5_000);
    // expectedCash = 100k + 80k + 20k − 5k = 195k
    expect(totals!.expectedCash).toBe(195_000);
    // salesTotal suma TODAS las ventas (no solo efectivo)
    expect(totals!.salesTotal).toBe(80_000);
    expect(totals!.salesCount).toBe(2);
  });

  it('solo cuenta como efectivo las ventas con método cash (no tarjeta/crédito)', async () => {
    const saleDocs = [
      { total: 40_000, tip: 0, payment: { method: 'cash' } },
      { total: 60_000, tip: 0, payment: { method: 'card' } },
      { total: 25_000, tip: 0, payment: { method: 'credit' } },
      { total: 15_000, tip: 0, payment: { method: 'transfer' } },
    ];
    wire(saleDocs, []);

    const { totals } = await service.current(sedeId.toString(), user);

    // Solo la venta 'cash' entra al efectivo.
    expect(totals!.cashSalesTotal).toBe(40_000);
    // salesTotal agrega todas las ventas del turno.
    expect(totals!.salesTotal).toBe(140_000);
    expect(totals!.salesCount).toBe(4);
    // expectedCash = 100k + 40k + 0 − 0 = 140k
    expect(totals!.expectedCash).toBe(140_000);
  });

  it('la propina en efectivo se suma al efectivo esperado (se cobra encima del total)', async () => {
    const saleDocs = [
      { total: 50_000, tip: 5_000, payment: { method: 'cash' } },
      // La propina de una venta con tarjeta NO entra al cajón de efectivo.
      { total: 30_000, tip: 3_000, payment: { method: 'card' } },
    ];
    wire(saleDocs, []);

    const { totals } = await service.current(sedeId.toString(), user);

    // cashSalesTotal = (50k + 5k propina) = 55k; la tarjeta no aporta.
    expect(totals!.cashSalesTotal).toBe(55_000);
    // salesTotal NO incluye propina: 50k + 30k = 80k.
    expect(totals!.salesTotal).toBe(80_000);
    // expectedCash = 100k + 55k = 155k.
    expect(totals!.expectedCash).toBe(155_000);
  });

  it('los movimientos de salida (out y sangria) restan del efectivo; solo "in" suma', async () => {
    const saleDocs = [{ total: 10_000, tip: 0, payment: { method: 'cash' } }];
    const movementDocs = [
      { type: 'in', amount: 8_000 },
      { type: 'out', amount: 3_000 },
      // Cualquier tipo distinto de 'in' se trata como salida (filter type !== 'in').
      { type: 'sangria', amount: 2_000 },
    ];
    wire(saleDocs, movementDocs);

    const { totals } = await service.current(sedeId.toString(), user);

    expect(totals!.movementsIn).toBe(8_000);
    // 3k (out) + 2k (sangria) = 5k de salidas.
    expect(totals!.movementsOut).toBe(5_000);
    // expectedCash = 100k + 10k + 8k − 5k = 113k.
    expect(totals!.expectedCash).toBe(113_000);
  });

  it('sin ventas ni movimientos el efectivo esperado es solo la base de apertura', async () => {
    wire([], []);

    const { totals } = await service.current(sedeId.toString(), user);

    expect(totals!.cashSalesTotal).toBe(0);
    expect(totals!.movementsIn).toBe(0);
    expect(totals!.movementsOut).toBe(0);
    expect(totals!.expectedCash).toBe(openingAmount);
  });
});
