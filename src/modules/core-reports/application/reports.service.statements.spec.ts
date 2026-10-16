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

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ROLES } from '../../core-auth/domain/roles';

const SEDE1 = '64b0000000000000000000a1';

/** El Dueño ve todas las sedes: los informes salen sin filtro de sede. */
const DUENO = { role: ROLES.OWNER, permissions: [], sedeIds: [] };

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
      }, DUENO);

      expect(r.totalIngresos).toBe(10_000_000);
      expect(r.totalGastos).toBe(8_000_000);
      expect(r.utilidadNeta).toBe(2_000_000);
    });

    it('separa ingresos de gastos, sin mezclar activos ni pasivos', async () => {
      const r = await service.incomeStatement({}, DUENO);

      expect(r.ingresos.map((l) => l.code)).toEqual(['4135']);
      expect(r.gastos.map((l) => l.code)).toEqual(['5105', '6135']);
    });

    it('un periodo con pérdida da utilidad negativa, no cero', async () => {
      build([
        fila('4135', 'Ingresos por ventas', 'income', 3_000_000),
        fila('5105', 'Gastos de personal', 'expense', 5_000_000),
      ]);

      const r = await service.incomeStatement({}, DUENO);

      expect(r.utilidadNeta).toBe(-2_000_000);
    });

    it('las cuentas sin movimiento no ensucian el informe', async () => {
      build([
        fila('4135', 'Ingresos por ventas', 'income', 1_000_000),
        fila('4175', 'Devoluciones', 'income', 0),
      ]);

      const r = await service.incomeStatement({}, DUENO);

      expect(r.ingresos).toHaveLength(1);
    });

    it('las devoluciones (4175) RESTAN del ingreso, no suman (ítem 1.16)', async () => {
      // La 4175 es de ingreso pero su saldo es débito: el ledger la entrega
      // negativa en el lado natural del ingreso. Con el valor absoluto, $10 M
      // vendidos y $2 M devueltos salían como $12 M de ingresos.
      build([
        fila('4135', 'Ingresos por ventas', 'income', 10_000_000),
        fila('4175', 'Devoluciones en ventas', 'income', -2_000_000),
        fila('6135', 'Costo de venta', 'expense', 4_000_000),
        fila('7205', 'Mano de obra absorbida', 'expense', -500_000),
      ]);

      const r = await service.incomeStatement({}, DUENO);

      expect(r.totalIngresos).toBe(8_000_000);
      expect(r.ingresos.find((l) => l.code === '4175')?.amount).toBe(-2_000_000);
      expect(r.totalGastos).toBe(3_500_000);
      expect(r.utilidadNeta).toBe(4_500_000);
    });

    it('sin movimiento en el periodo todo sale en cero, no falla', async () => {
      build([]);

      const r = await service.incomeStatement({}, DUENO);

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
        sedeId: SEDE1,
      }, DUENO);

      expect(ledger.trialBalance).toHaveBeenCalledWith({
        from: '2026-01-01',
        to: '2026-03-31',
        sedeId: SEDE1,
      });
    });
  });

  describe('balance general', () => {
    it('cuadra: el activo es igual al pasivo más el patrimonio', async () => {
      const r = await service.balanceSheet({ to: '2026-12-31' }, DUENO);

      expect(r.totalActivo).toBe(8_000_000);
      expect(r.totalPasivo).toBe(2_000_000);
      expect(r.totalPatrimonio).toBe(6_000_000);
      expect(r.totalActivo).toBe(r.totalPasivo + r.totalPatrimonio);
      expect(r.cuadra).toBe(true);
    });

    it('la utilidad del ejercicio suma al patrimonio antes del cierre', async () => {
      const r = await service.balanceSheet({}, DUENO);

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

      const r = await service.balanceSheet({}, DUENO);

      expect(r.resultadoEjercicio).toBe(-2_000_000);
      expect(r.totalPatrimonio).toBe(2_000_000);
      expect(r.cuadra).toBe(true);
    });

    it('con devoluciones y un IVA a favor sigue cuadrando (ítem 1.16)', async () => {
      // Venta 10 M − devolución 2 M = caja 8 M; un IVA a favor de 300.000
      // (2408 con saldo débito, negativo en el lado del pasivo) contra 300.000
      // menos de caja. Con el valor absoluto el balance no cuadraba.
      build([
        fila('1105', 'Caja', 'asset', 7_700_000),
        fila('2408', 'IVA por pagar', 'liability', -300_000),
        fila('4135', 'Ingresos por ventas', 'income', 10_000_000),
        fila('4175', 'Devoluciones en ventas', 'income', -2_000_000),
      ]);

      const r = await service.balanceSheet({}, DUENO);

      expect(r.resultadoEjercicio).toBe(8_000_000);
      expect(r.totalPasivo).toBe(-300_000);
      expect(r.cuadra).toBe(true);
    });

    it('avisa cuando NO cuadra, en vez de disimularlo', async () => {
      // Balance incoherente: el activo no corresponde con pasivo + patrimonio.
      build([
        fila('1105', 'Caja', 'asset', 9_000_000),
        fila('3105', 'Capital', 'equity', 4_000_000),
      ]);

      const r = await service.balanceSheet({}, DUENO);

      expect(r.cuadra).toBe(false);
    });

    it('el balance general no lleva rango: es una foto a una fecha', async () => {
      await service.balanceSheet({ to: '2026-12-31', sedeId: SEDE1 }, DUENO);

      expect(ledger.trialBalance).toHaveBeenCalledWith({
        to: '2026-12-31',
        sedeId: SEDE1,
      });
    });
  });
});

/**
 * Alcance por sede (checklist 3.3). Un Gerente de la sede A no puede ver los
 * estados financieros de toda la empresa ni los de otra sede: si pide una sede
 * ajena recibe 403, y si no pide ninguna el informe se arma solo con las suyas.
 */
describe('ReportsService · alcance por sede', () => {
  const S1 = '64b000000000000000000001';
  const S2 = '64b000000000000000000002';
  const AJENA = '64b000000000000000000009';
  const gerente = (sedeIds: string[]) => ({
    role: ROLES.MANAGER,
    permissions: [],
    sedeIds,
  });

  // El saldo en su lado natural, como lo entrega `LedgerService.trialBalance`:
  // débito − crédito para activo y gasto, crédito − débito para el resto.
  function fila(code: string, type: string, debit: number, credit: number) {
    const deudora = type === 'asset' || type === 'expense';
    const balance = deudora ? debit - credit : credit - debit;
    return { code, name: code, type, typeLabel: type, debit, credit, balance };
  }

  let ledger: any;
  let sales: any;
  let service: ReportsService;

  beforeEach(() => {
    ledger = {
      trialBalance: vi.fn(async (q: { sedeId?: string }) => {
        const porSede: Record<string, any[]> = {
          [S1]: [fila('4135', 'income', 0, 1_000)],
          [S2]: [fila('4135', 'income', 0, 500), fila('5105', 'expense', 300, 0)],
        };
        const rows = q.sedeId ? (porSede[q.sedeId] ?? []) : [fila('4135', 'income', 0, 99_999)];
        const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
        const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
        return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
      }),
    };
    sales = {
      aggregate: vi.fn(() => ({ exec: async () => [] })),
    };
    service = new ReportsService(ledger as never, sales as never);
  });

  it('pedir una sede ajena es 403 en los cuatro informes', async () => {
    const u = gerente([S1]);
    await expect(service.incomeStatement({ sedeId: AJENA }, u)).rejects.toThrow(ForbiddenException);
    await expect(service.balanceSheet({ sedeId: AJENA }, u)).rejects.toThrow(ForbiddenException);
    await expect(service.trialBalance({ sedeId: AJENA }, u)).rejects.toThrow(ForbiddenException);
    await expect(service.salesReport({ sedeId: AJENA }, u)).rejects.toThrow(ForbiddenException);
    expect(ledger.trialBalance).not.toHaveBeenCalled();
    expect(sales.aggregate).not.toHaveBeenCalled();
  });

  it('sin sede, el gerente de una sede ve solo la suya, nunca la empresa', async () => {
    const r = await service.incomeStatement({ from: '2026-01-01' }, gerente([S1]));

    expect(ledger.trialBalance).toHaveBeenCalledWith({ from: '2026-01-01', to: undefined, sedeId: S1 });
    expect(r.totalIngresos).toBe(1_000);
  });

  it('sin sede, quien tiene varias sedes ve la suma de las suyas', async () => {
    const r = await service.incomeStatement({}, gerente([S1, S2]));

    expect(ledger.trialBalance).toHaveBeenCalledTimes(2);
    expect(r.totalIngresos).toBe(1_500);
    expect(r.totalGastos).toBe(300);
    expect(r.utilidadNeta).toBe(1_200);
  });

  it('marca el alcance: empresa para el Dueño, sedes para el limitado', async () => {
    const dueno = await service.incomeStatement({}, DUENO);
    expect(dueno.alcance).toBe('empresa');
    expect(dueno).not.toHaveProperty('sedes');

    const u = gerente([S1, S2]);
    const ing = await service.incomeStatement({}, u);
    const bal = await service.balanceSheet({}, u);
    const tb = await service.trialBalance({}, u);
    for (const r of [ing, bal, tb]) {
      expect(r.alcance).toBe('sedes');
      expect((r as any).sedes).toEqual([S1, S2]);
    }
    // El Dueño que filtra por una sede tampoco es la empresa completa.
    const una = await service.trialBalance({ sedeId: S1 }, DUENO);
    expect(una.alcance).toBe('sedes');
    expect((una as any).sedes).toEqual([S1]);
  });

  it('un sedeId mal formado es 400 y no toca el ledger ni la base', async () => {
    const u = gerente([S1]);
    await expect(service.incomeStatement({ sedeId: 'xx' }, u)).rejects.toThrow(BadRequestException);
    await expect(service.balanceSheet({ sedeId: 'xx' }, DUENO)).rejects.toThrow(BadRequestException);
    await expect(service.trialBalance({ sedeId: 'xx' }, DUENO)).rejects.toThrow(BadRequestException);
    await expect(service.salesReport({ sedeId: 'xx' }, DUENO)).rejects.toThrow(BadRequestException);
    expect(ledger.trialBalance).not.toHaveBeenCalled();
    expect(sales.aggregate).not.toHaveBeenCalled();
  });

  it('sin sedes asignadas no ve nada, en vez de ver toda la empresa', async () => {
    const r = await service.trialBalance({}, gerente([]));

    expect(r.rows).toEqual([]);
    expect(ledger.trialBalance).not.toHaveBeenCalled();
  });

  it('el reporte de ventas se filtra a las sedes del usuario', async () => {
    await service.salesReport({}, gerente([S1, S2]));

    const match = sales.aggregate.mock.calls[0][0][0].$match;
    expect(match.sedeId.$in.map(String)).toEqual([S1, S2]);
  });

  it('el reporte de ventas del dueño no lleva filtro de sede', async () => {
    await service.salesReport({}, DUENO);

    const match = sales.aggregate.mock.calls[0][0][0].$match;
    expect(match.sedeId).toBeUndefined();
  });
});
