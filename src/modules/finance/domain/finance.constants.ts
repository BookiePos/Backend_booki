/**
 * Constantes del módulo de Finanzas (Fase 1, enfoque pragmático COP entero).
 * Sin doble partida: agregación on-the-fly. Cada categoría deja `accountCode?`
 * (PUC futuro) y cada documento un `sourceType`/`autoSource`.
 */

/** Naturaleza contable de una categoría (para el P&L y el presupuesto). */
export const CATEGORY_KINDS = [
  'income',
  'cogs',
  'payroll',
  'expense',
  'tax',
  'other',
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** Origen automático de una categoría de sistema (de dónde sale su "Real"). */
export const CATEGORY_AUTO_SOURCES = [
  'sales',
  'payroll',
  'caja',
  'inventory',
] as const;
export type CategoryAutoSource = (typeof CATEGORY_AUTO_SOURCES)[number];

/** Estado de un gasto: pagado o por pagar (cuenta por pagar). */
export const EXPENSE_STATUSES = ['paid', 'payable'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** Medio de pago de un gasto/movimiento. */
export const PAYMENT_METHODS = ['cash', 'transfer', 'card'] as const;
export type FinancePaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Estado de una cuenta por pagar. */
export const PAYABLE_STATUSES = ['open', 'partial', 'paid', 'void'] as const;
export type PayableStatus = (typeof PAYABLE_STATUSES)[number];

/** Estado de una cuenta por cobrar (fiado). Mismo ciclo que las CxP. */
export const RECEIVABLE_STATUSES = ['open', 'partial', 'paid', 'void'] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number];

/** Tipo de una cuenta financiera (tesorería). */
export const ACCOUNT_TYPES = ['bank', 'cash', 'wallet'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Sentido de un movimiento de cuenta. */
export const MOVEMENT_DIRECTIONS = ['in', 'out'] as const;
export type MovementDirection = (typeof MOVEMENT_DIRECTIONS)[number];

/** Escenario de un presupuesto. */
export const BUDGET_SCENARIOS = ['base', 'optimista', 'pesimista'] as const;
export type BudgetScenario = (typeof BUDGET_SCENARIOS)[number];

/** Estado de un presupuesto. */
export const BUDGET_STATUSES = ['draft', 'active'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/**
 * Set base de categorías de sistema que se siembra la primera vez.
 * Las de `autoSource` traen su "Real" de otra fuente (ventas/nómina/inventario);
 * las de gasto son editables por el usuario.
 */
export const SEED_CATEGORIES: {
  name: string;
  kind: CategoryKind;
  autoSource: CategoryAutoSource | null;
  accountCode?: string;
}[] = [
  { name: 'Ventas', kind: 'income', autoSource: 'sales', accountCode: '4135' },
  {
    name: 'Costo de mercancía',
    kind: 'cogs',
    autoSource: 'inventory',
    accountCode: '6135',
  },
  { name: 'Nómina', kind: 'payroll', autoSource: 'payroll', accountCode: '5105' },
  { name: 'IVA', kind: 'tax', autoSource: 'sales', accountCode: '2408' },
  { name: 'Arriendo', kind: 'expense', autoSource: null, accountCode: '5120' },
  {
    name: 'Servicios públicos',
    kind: 'expense',
    autoSource: null,
    accountCode: '5135',
  },
  {
    name: 'Comisiones datáfono',
    kind: 'expense',
    autoSource: null,
    accountCode: '5305',
  },
  { name: 'Otros gastos', kind: 'expense', autoSource: null },
];
