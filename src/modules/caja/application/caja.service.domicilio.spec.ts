import { describe, it, expect, vi } from 'vitest';
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
 * Arqueo con domicilios (checklist 1.5): el envío cobrado en efectivo entra al cajón.
 *
 * `summarize` es privado; se ejercita a través del método público `current`,
 * que llama a `findOpen` (sessions.findOne...exec) y luego a `summarize`
 * (sales.find...exec + movements.find...sort...exec). Inyectamos los totales
 * mockeando el resultado de esas consultas y validamos la fórmula:
 *   expectedCash = openingAmount + cashSalesTotal + movementsIn − movementsOut
 *
 * Constructor (orden): (sessions, movements, sales, orders, sedes, params)
 */
describe('CajaService.summarize con domicilios', () => {
  const sedeId = new Types.ObjectId();
  const user = {
    userId: 'u1', email: 'c@erp.local', name: 'C', role: 'cashier',
    sedeIds: [sedeId.toString()], permissions: [],
  } as unknown as JwtUser;

  function build(saleDocs: any[]) {
    const sessions = {
      findOne: vi.fn().mockReturnValue({
        exec: () => Promise.resolve({ _id: new Types.ObjectId(), sedeId, status: 'open', openingAmount: 100_000 }),
      }),
    };
    const sales = { find: vi.fn().mockReturnValue({ exec: () => Promise.resolve(saleDocs) }) };
    const movements = {
      find: vi.fn().mockReturnValue({ sort: () => ({ exec: () => Promise.resolve([]) }) }),
    };
    return new CajaService(sessions as any, movements as any, sales as any, {} as any, {} as any, {} as any);
  }

  it('domicilio en efectivo: total + propina + envío entran al efectivo esperado', async () => {
    const service = build([
      { total: 50_000, tip: 5_000, deliveryFee: 4_000, payment: { method: 'cash' } },
    ]);
    const { totals } = await service.current(sedeId.toString(), user);
    expect(totals!.cashSalesTotal).toBe(59_000);
    expect(totals!.expectedCash).toBe(159_000);
    expect(totals!.salesTotal).toBe(50_000);
  });

  it('domicilio con tarjeta/transferencia no aporta efectivo; venta sin deliveryFee (legado) sigue igual', async () => {
    const service = build([
      { total: 30_000, tip: 0, deliveryFee: 4_000, payment: { method: 'card' } },
      { total: 20_000, tip: 0, deliveryFee: 3_000, payment: { method: 'transfer' } },
      { total: 10_000, tip: 1_000, payment: { method: 'cash' } },
    ]);
    const { totals } = await service.current(sedeId.toString(), user);
    expect(totals!.cashSalesTotal).toBe(11_000);
    expect(totals!.expectedCash).toBe(111_000);
  });
});
