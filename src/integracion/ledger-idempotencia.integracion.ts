import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACC } from '../modules/core-ledger/domain/ledger.constants';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Idempotencia del libro contra un Mongo real (checklist 5.8): postear dos
 * veces el mismo origen deja un solo asiento vivo, también en paralelo. Lo
 * garantizan `safePost` (atajo) y el índice único `origen_vivo_unico` (carrera).
 */
describe('ledger · un asiento vivo por origen', () => {
  const EMPRESA = 'cccccccccccccccccccccccc';
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let env: Entorno;

  const venta = (saleId: string) => ({
    saleId,
    number: `FV-${saleId}`,
    date: '2026-10-14',
    sedeId: SEDE,
    total: 11_900,
    tax: 1_900,
    cogs: 0,
    paymentMethod: 'cash',
  });
  const asientosDe = (saleId: string) =>
    env.baseDe(EMPRESA).collection('ledger_journal_entries').find({ sourceType: 'sale', sourceId: saleId }).toArray();

  beforeAll(async () => {
    env = await levantarEntorno();
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  it('el índice único origen_vivo_unico existe en la base de la empresa', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    const indices = await env.baseDe(EMPRESA).collection('ledger_journal_entries').indexes();
    expect(indices.find((i) => i.name === 'origen_vivo_unico')?.unique).toBe(true);
  });

  it('postSale dos veces seguidas con el mismo origen crea un solo asiento', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      await env.posting.postSale(venta('seq-1'));
      await env.posting.postSale(venta('seq-1'));
    });
    expect(await asientosDe('seq-1')).toHaveLength(1);
  });

  it('postSale en paralelo (20 a la vez) crea un solo asiento y no deja pendientes', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      await Promise.all(Array.from({ length: 20 }, () => env.posting.postSale(venta('par-1'))));
    });
    expect(await asientosDe('par-1')).toHaveLength(1);
    expect(await env.enEmpresa(EMPRESA, () => env.conciliacion.contarAbiertos())).toBe(0);
  });

  it('ledger.post en paralelo con el mismo origen devuelve el mismo asiento a todos', async () => {
    const resultados = await env.enEmpresa(EMPRESA, () =>
      Promise.all(
        Array.from({ length: 15 }, () =>
          env.ledger.post({
            date: '2026-10-14',
            sourceType: 'sale',
            sourceId: 'par-2',
            lines: [
              { accountCode: ACC.CAJA, debit: 500 },
              { accountCode: ACC.INGRESOS_VENTAS, credit: 500 },
            ],
          }),
        ),
      ),
    );
    expect(new Set(resultados.map((r) => String(r._id))).size).toBe(1);
    expect(await asientosDe('par-2')).toHaveLength(1);
  });

  it('orígenes distintos en paralelo crean un asiento cada uno, con consecutivos sin repetir', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `multi-${i}`);
    await env.enEmpresa(EMPRESA, () => Promise.all(ids.map((id) => env.posting.postSale(venta(id)))));
    const todos = (await Promise.all(ids.map((id) => asientosDe(id)))).flat();
    expect(todos).toHaveLength(12);
    expect(new Set(todos.map((a) => a['number'])).size).toBe(12);
  });
});
