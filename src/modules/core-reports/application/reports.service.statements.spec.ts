import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { ReportsService } from './reports.service';

/**
 * Estado de resultados y balance general.
 *
 * Son los dos números con los que el dueño decide: si el negocio gana o pierde,
 * y qué tiene frente a lo que debe. Ambos se derivan del balance de
 * comprobación, así que un signo o una clasificación mal puesta no rompe nada
 * visible: simplemente dan una cifra equivocada, con toda la apariencia de ser
 * correcta.
 *
 * La prueba parte de un balance de comprobación sintético con saldos ya en su
 * lado natural (activo y gasto por débito; pasivo, patrimonio e ingreso por
 * crédito), que es como lo entrega el ledger.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (ledger, sales).
 */
describe('ReportsService · estados financieros', () => {
  let ledger: any;
  let service: ReportsService;

  /** Un renglón del balance de comprobación. */
  function fila(
    code: string,
    name: string,
    type: string,
    balance: number,
  ) {
    return { code, name, type, typeLabel: type, debit: 0, credit: 0, balance };
  }

  /**
   * Empresa con: caja 5.000.000, inventario 3.000.000, proveedores 2.000.000,
   * capital 4.000.000, ventas 10.000.000 y gastos 8.000.000.
   * Activo 8.000.000 = pasivo 2.000.000 + patrimonio (4.000.000 + 2.000.000).
   */
  const BALANCE = [
    fila('1105', 'Caja', 'asset', 5_000_000),
    fila('1435', 'Inventario', 'asset', 3_000_000),
    fila('2205', 'Proveedores', 'liability', 2_000_000),
    fila('3105', 'Capital', 'equity', 4_000_000),
    fila('4135', 'Ingresos por ventas', 'income', 10_000_000),
    fila('5105', 'Gastos de personal', 'expense', 6_000_000),
    fila('6135', 'Costo de venta', 'expense', 2_000_000),
  ];

  function build(rows: any[] = BALANCE) {
    ledger = {
      trialBalance: vi.fn().mockResolvedValue({
        rows,
        totalDebit: 0,
        totalCredit: 0,
        balanced: true,
      }),
    };
    service = new ReportsService(ledger as never, {} as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    build();
  });

  describe('estado de resultados', () => {
    it('la utilidad es ingresos menos gastos', async () => {
      const r = await service.incomeStatement({
        from: '2026-01-01',
        to: '2026-12-31',
      });

      expect(r.totalIngresos).toBe(10_000_000);
      expect(r.totalGastos).toBe(8_000_000);
      expect(r.utilidadNeta).toBe(2_000_000);
    });

    it('separa ingresos de gastos, sin mezclar activos ni pasivos', async () => {
      const r = await service.incomeStatement({});

      expect(r.ingresos.map((l) => l.code)).toEqual(['4135']);
      expect(r.gastos.map((l) => l.code)).toEqual(['5105', '6135']);
    });

    it('un periodo con pérdida da utilidad negativa, no cero', async () => {
      build([
        fila('4135', 'Ingresos por ventas', 'income', 3_000_000),
        fila('5105', 'Gastos de personal', 'expense', 5_000_000),
      ]);

      const r = await service.incomeStatement({});

      expect(r.utilidadNeta).toBe(-2_000_000);
    });

    it('las cuentas sin movimiento no ensucian el informe', async () => {
      build([
        fila('4135', 'Ingresos por ventas', 'income', 1_000_000),
        fila('4175', 'Devoluciones', 'income', 0),
      ]);

      const r = await service.incomeStatement({});

      expect(r.ingresos).toHaveLength(1);
    });

    it('sin movimiento en el periodo todo sale en cero, no falla', async () => {
      build([]);

      const r = await service.incomeStatement({});

      expect(r).toMatchObject({
        totalIngresos: 0,
        totalGastos: 0,
        utilidadNeta: 0,
      });
    });

    it('pasa el rango y la sede al ledger tal cual', async () => {
      await service.incomeStatement({
        from: '2026-01-01',
        to: '2026-03-31',
        sedeId: 'sede1',
      });

      expect(ledger.trialBalance).toHaveBeenCalledWith({
        from: '2026-01-01',
        to: '2026-03-31',
        sedeId: 'sede1',
      });
    });
  });

  describe('balance general', () => {
    it('cuadra: el activo es igual al pasivo más el patrimonio', async () => {
      const r = await service.balanceSheet({ to: '2026-12-31' });

      expect(r.totalActivo).toBe(8_000_000);
      expect(r.totalPasivo).toBe(2_000_000);
      expect(r.totalPatrimonio).toBe(6_000_000);
      expect(r.totalActivo).toBe(r.totalPasivo + r.totalPatrimonio);
      expect(r.cuadra).toBe(true);
    });

    it('la utilidad del ejercicio suma al patrimonio antes del cierre', async () => {
      const r = await service.balanceSheet({});

      // Capital 4.000.000 + resultado 2.000.000.
      expect(r.resultadoEjercicio).toBe(2_000_000);
      expect(r.totalPatrimonio).toBe(6_000_000);
    });

    it('una pérdida resta del patrimonio', async () => {
      build([
        fila('1105', 'Caja', 'asset', 2_000_000),
        fila('3105', 'Capital', 'equity', 4_000_000),
        fila('4135', 'Ingresos por ventas', 'income', 1_000_000),
        fila('5105', 'Gastos de personal', 'expense', 3_000_000),
      ]);

      const r = await service.balanceSheet({});

      expect(r.resultadoEjercicio).toBe(-2_000_000);
      expect(r.totalPatrimonio).toBe(2_000_000);
      expect(r.cuadra).toBe(true);
    });

    it('avisa cuando NO cuadra, en vez de disimularlo', async () => {
      // Balance incoherente: el activo no corresponde con pasivo + patrimonio.
      build([
        fila('1105', 'Caja', 'asset', 9_000_000),
        fila('3105', 'Capital', 'equity', 4_000_000),
      ]);

      const r = await service.balanceSheet({});

      expect(r.cuadra).toBe(false);
    });

    it('el balance general no lleva rango: es una foto a una fecha', async () => {
      await service.balanceSheet({ to: '2026-12-31', sedeId: 'sede1' });

      expect(ledger.trialBalance).toHaveBeenCalledWith({
        to: '2026-12-31',
        sedeId: 'sede1',
      });
    });
  });
});
