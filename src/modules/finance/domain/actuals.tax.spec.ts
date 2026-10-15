import { describe, it, expect, vi } from 'vitest';

// actuals.ts importa los esquemas (tipos de documento); mismo patrón que el
// resto de las pruebas para neutralizar los decoradores de @nestjs/mongoose.
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

import { actualForCategory, ivaEIncDeVentas } from './actuals';

/**
 * El «Real» de la categoría IVA (2408) y el P&L contaban todo `taxTotal` como
 * IVA, incluido el INC de los restaurantes. El INC no es IVA: se declara en
 * otro formulario y no admite restarle IVA descontable.
 */
describe('actuals · IVA e INC de las ventas por separado', () => {
  /** Venta de restaurante: todo INC. */
  const restaurante = {
    taxTotal: 2_222,
    lines: [{ taxKind: 'inc', taxAmount: 2_222 }],
  };
  /** Venta de retail: IVA 19 %. */
  const retail = {
    taxTotal: 1_900,
    lines: [{ taxKind: 'iva', taxAmount: 1_900 }],
  };
  /** Venta anterior a `taxKind`: era IVA. */
  const antigua = { taxTotal: 950, lines: [{ taxAmount: 950 }] };

  function models(
    sales: unknown[],
    expenses: unknown[] = [],
    admiteIvaDescontable: (sedeId?: string) => boolean = () => true,
    ivaCompras = 0,
  ) {
    const q = (docs: unknown[]) => ({
      select: () => ({ exec: () => Promise.resolve(docs) }),
      exec: () => Promise.resolve(docs),
    });
    return {
      sales: { find: vi.fn(() => q(sales)) },
      runs: { find: vi.fn(() => q([])) },
      expenses: { find: vi.fn(() => q(expenses)) },
      admiteIvaDescontable,
      ivaDescontableDeCompras: vi.fn(() => Promise.resolve(ivaCompras)),
    } as never;
  }

  const range = { from: '2026-10-01', to: '2026-10-31' };

  it('separa el INC del IVA por el tipo de cada línea (sin tipo = IVA)', async () => {
    const r = await ivaEIncDeVentas(
      models([restaurante, retail, antigua]),
      range,
      null,
    );

    expect(r).toEqual({ iva: 2_850, inc: 2_222 });
  });

  it('el «Real» de la categoría IVA no incluye el INC', async () => {
    const real = await actualForCategory(
      models([restaurante, retail], [{ taxAmount: 300 }]),
      'tax',
      null,
      range,
      null,
    );

    // 1.900 de IVA generado − 300 descontable. El INC (2.222) no entra.
    expect(real).toBe(1_600);
  });

  it('el «Real» del IVA no resta descontables de una sede que no los admite', async () => {
    // Sede A responsable (descuenta 300); sede B no responsable o restaurante
    // (sus 500 de IVA pagado son costo, no descontable: arts. 437 y 488 ET).
    const real = await actualForCategory(
      models(
        [retail],
        [
          { taxAmount: 300, sedeId: 'A' },
          { taxAmount: 500, sedeId: 'B' },
        ],
        (sedeId) => sedeId === 'A',
      ),
      'tax',
      null,
      range,
      null,
    );

    expect(real).toBe(1_600);
  });

  it('el «Real» del IVA resta también el IVA descontable de las compras (2408)', async () => {
    // Responsable que compra 1.000.000 + 190.000: la recepción debitó 190.000 a la 2408.
    const real = await actualForCategory(
      models([retail], [{ taxAmount: 300, sedeId: 'A' }], () => true, 190_000),
      'tax',
      null,
      range,
      null,
    );

    expect(real).toBe(1_900 - 300 - 190_000);
  });

  it('el «Real» de un gasto lleva su IVA cuando la sede no lo descuenta', async () => {
    const real = await actualForCategory(
      models(
        [],
        [
          { amount: 100_000, taxAmount: 19_000, sedeId: 'A' },
          { amount: 100_000, taxAmount: 19_000, sedeId: 'B' },
        ],
        (sedeId) => sedeId === 'A',
      ),
      'expense',
      null,
      range,
      null,
    );

    // A descuenta (100.000); B no (119.000).
    expect(real).toBe(219_000);
  });
});
