import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACC } from '../modules/core-ledger/domain/ledger.constants';
import { dbNameForBusiness } from '../shared/tenancy/tenant-context';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Tenancy contra un Mongo real (checklist 5.8): cada empresa vive en su base
 * `biz_<id>` y los servicios reales del libro, usados con el contexto de una
 * empresa, nunca ven ni tocan los datos de la otra.
 */
describe('tenancy · dos empresas, un Mongo', () => {
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  let env: Entorno;

  const lineas = (monto: number) => [
    { accountCode: ACC.CAJA, debit: monto },
    { accountCode: ACC.INGRESOS_VENTAS, credit: monto },
  ];

  beforeAll(async () => {
    env = await levantarEntorno();
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  it('un asiento de A no aparece en B y cada base guarda el suyo', async () => {
    const deA = await env.enEmpresa(A, () =>
      env.ledger.post({ date: '2026-10-14', sourceType: 'sale', sourceId: 'venta-A', lines: lineas(10_000) }),
    );
    await env.enEmpresa(B, () =>
      env.ledger.post({ date: '2026-10-14', sourceType: 'sale', sourceId: 'venta-B', lines: lineas(55_000) }),
    );

    const vistoPorA = await env.enEmpresa(A, () => env.ledger.listEntries({}));
    const vistoPorB = await env.enEmpresa(B, () => env.ledger.listEntries({}));
    expect(vistoPorA.map((e) => e.sourceId)).toEqual(['venta-A']);
    expect(vistoPorB.map((e) => e.sourceId)).toEqual(['venta-B']);

    // Buscar por origen: B no encuentra el asiento de A.
    expect(await env.enEmpresa(B, () => env.ledger.findBySource('sale', 'venta-A'))).toBeNull();
    const enA = await env.enEmpresa(A, () => env.ledger.findBySource('sale', 'venta-A'));
    expect(String(enA?._id)).toBe(String(deA._id));

    // Y físicamente están en bases distintas.
    expect(await env.baseDe(A).collection('ledger_journal_entries').countDocuments()).toBe(1);
    expect(await env.baseDe(B).collection('ledger_journal_entries').countDocuments()).toBe(1);
    const dbs = (await env.root.getClient().db().admin().listDatabases()).databases.map((d) => d.name);
    expect(dbs).toEqual(expect.arrayContaining([dbNameForBusiness(A), dbNameForBusiness(B)]));
  });

  it('el consecutivo y el plan de cuentas son de cada empresa', async () => {
    const a2 = await env.enEmpresa(A, () =>
      env.ledger.post({ date: '2026-10-14', sourceType: 'sale', sourceId: 'venta-A2', lines: lineas(1_000) }),
    );
    const b2 = await env.enEmpresa(B, () =>
      env.ledger.post({ date: '2026-10-14', sourceType: 'sale', sourceId: 'venta-B2', lines: lineas(2_000) }),
    );
    // Ambas llevan su segundo asiento: el contador no se comparte.
    expect(a2.number).toBe('AS-000002');
    expect(b2.number).toBe('AS-000002');

    const cuentasA = await env.enEmpresa(A, () => env.ledger.listAccounts());
    const cuentasB = await env.enEmpresa(B, () => env.ledger.listAccounts());
    expect(cuentasA.length).toBeGreaterThan(0);
    expect(cuentasB.length).toBe(cuentasA.length);
    expect(await env.baseDe(A).collection('ledger_accounts').countDocuments()).toBe(cuentasA.length);
  });

  it('el mismo origen puede existir en ambas empresas (el índice único es por base)', async () => {
    await env.enEmpresa(A, () =>
      env.ledger.post({ date: '2026-10-14', sourceType: 'expense', sourceId: 'gasto-1', lines: lineas(300) }),
    );
    await env.enEmpresa(B, () =>
      env.ledger.post({ date: '2026-10-14', sourceType: 'expense', sourceId: 'gasto-1', lines: lineas(900) }),
    );
    const enA = await env.enEmpresa(A, () => env.ledger.findBySource('expense', 'gasto-1'));
    const enB = await env.enEmpresa(B, () => env.ledger.findBySource('expense', 'gasto-1'));
    expect(enA?.totalDebit).toBe(300);
    expect(enB?.totalDebit).toBe(900);
  });

  it('sin contexto de empresa no se llega a ninguna base', async () => {
    await expect(env.ledger.listEntries({})).rejects.toThrow();
  });
});
