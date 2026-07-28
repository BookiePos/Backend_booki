/**
 * Ledger de partida doble — implementación pragmática.
 *
 * Enfoque consistente con el resto del ERP: montos en COP entero (no float,
 * no Decimal128 todavía; ver money.util de Finanzas). Lo que sí se respeta del
 * diseño contable:
 *  - Un asiento es INMUTABLE: nunca se edita, se reversa con un contra-asiento.
 *  - Débitos == Créditos (balanceado) en cada asiento.
 *  - Todo asiento referencia el evento de negocio que lo originó (sourceType/Id).
 */

export const ACCOUNT_TYPES = [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Activo',
  liability: 'Pasivo',
  equity: 'Patrimonio',
  income: 'Ingreso',
  expense: 'Gasto',
};

/** Lado natural (saldo normal) de cada tipo de cuenta. */
export const NATURAL_SIDE: Record<AccountType, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
}

/**
 * Plan de cuentas base (inspirado en el PUC colombiano, simplificado). No es
 * contabilidad formal certificada; es la columna vertebral para que los
 * reportes lean del ledger y no de las tablas operativas.
 */
export const SEED_ACCOUNTS: SeedAccount[] = [
  // Activo
  { code: '1105', name: 'Caja', type: 'asset' },
  { code: '1110', name: 'Bancos', type: 'asset' },
  { code: '1305', name: 'Clientes (CxC)', type: 'asset' },
  { code: '1435', name: 'Inventario de mercancías', type: 'asset' },
  // Pasivo
  { code: '2205', name: 'Proveedores (CxP)', type: 'liability' },
  { code: '2365', name: 'Retención en la fuente', type: 'liability' },
  { code: '2367', name: 'IVA por pagar', type: 'liability' },
  { code: '2368', name: 'INC por pagar', type: 'liability' },
  { code: '2380', name: 'Propinas por pagar', type: 'liability' },
  { code: '2505', name: 'Salarios por pagar', type: 'liability' },
  // Patrimonio
  { code: '3105', name: 'Capital', type: 'equity' },
  { code: '3605', name: 'Resultado del ejercicio', type: 'equity' },
  // Ingresos
  { code: '4135', name: 'Ingresos por ventas', type: 'income' },
  { code: '4175', name: 'Devoluciones en ventas', type: 'income' },
  // Gastos / costos
  { code: '5105', name: 'Gastos de personal', type: 'expense' },
  { code: '5135', name: 'Servicios (arriendo, públicos)', type: 'expense' },
  { code: '5195', name: 'Gastos diversos', type: 'expense' },
  { code: '6135', name: 'Costo de mercancía vendida', type: 'expense' },
];
