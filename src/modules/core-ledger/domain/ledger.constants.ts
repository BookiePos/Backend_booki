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

/** Códigos de cuenta usados por el posteo automático (deben existir en el seed). */
export const ACC = {
  CAJA: '1105',
  BANCOS: '1110',
  CLIENTES: '1305',
  /**
   * Cuentas por cobrar a trabajadores (PUC 1365): lo que un empleado queda
   * debiendo cuando sus deducciones superan lo devengado de la colilla.
   */
  CXC_TRABAJADORES: '1365',
  INVENTARIO: '1435',
  /**
   * Cuenta puente del modo sin conexión (ítem 6.3): mercancía vendida offline
   * que no estaba en el inventario registrado (venta autorizada con lo
   * cobrado). Su costo va a 6135 contra esta subcuenta de 1435 (saldo crédito)
   * hasta que se regulariza sacando ese stock cuando llega la compra o el
   * ajuste. PENDIENTE de confirmar por el contador.
   */
  INVENTARIO_POR_REGULARIZAR: '143595',
  PROVEEDORES: '2205',
  RETENCION_FUENTE: '2365',
  /**
   * IVA generado por pagar (PUC, Decreto 2650/93: 2408). No es la 2367: esa es
   * la ReteIVA que el negocio practica como agente retenedor.
   */
  IVA_POR_PAGAR: '2408',
  /**
   * INC de restaurantes y bares (arts. 512-1 y 512-9 ET). PUC 2495 (otros
   * impuestos por pagar); no es la 2368, que es la ReteICA.
   */
  INC_POR_PAGAR: '2495',
  /**
   * INC de bolsas plásticas (art. 512-15 ET, tributo DIAN 22). Subcuenta de la
   * 2495 y no la 2495 misma: se declara en el mismo formulario del INC (310)
   * pero en su propio renglón, y con la subcuenta el saldo sale directo sin
   * separarlo del INC de restaurante del 8 %.
   */
  INC_BOLSAS_POR_PAGAR: '249510',
  /** Propinas recibidas para el personal (Ley 1935/2018: no son ingreso). */
  PROPINAS_POR_PAGAR: '2380',
  /** Salud, pensión y FSP retenidos al empleado + aportes del empleador (PUC 2370). */
  APORTES_NOMINA: '2370',
  /**
   * Deducciones manuales de nómina (libranzas, embargos, cuotas a terceros):
   * PUC 2370 (237050 embargos, 237055 libranzas, 237095 otros). El modelo de
   * deducción no distingue el concepto, así que van todas aquí, en su propio
   * renglón. No son la 1305: esa la cancela solo el fiado del POS.
   */
  DEDUCCIONES_NOMINA_TERCEROS: '2370',
  SALARIOS_POR_PAGAR: '2505',
  /** Cesantías, intereses, prima y vacaciones causadas (PUC 2610). */
  PROVISIONES_LABORALES: '2610',
  /**
   * Retenciones que la plataforma practica al negocio al liquidar (anticipos de
   * impuestos a favor, PUC 1355): retención en la fuente, ReteIVA y ReteICA.
   */
  RETEFUENTE_A_FAVOR: '135515',
  RETEIVA_A_FAVOR: '135517',
  RETEICA_A_FAVOR: '135518',
  INGRESOS_VENTAS: '4135',
  /**
   * Mayor valor cobrado por la plataforma frente al precio del POS (menú de la
   * plataforma más caro). Ingreso no operacional (PUC 4295, diversos); el
   * contador confirma si causa IVA/INC.
   */
  MAYOR_VALOR_PLATAFORMAS: '4295',
  /** Devoluciones en ventas (PUC 4175): resta del ingreso, separada de él. */
  DEVOLUCIONES_VENTAS: '4175',
  GASTOS_PERSONAL: '5105',
  GASTOS_SERVICIOS: '5135',
  /**
   * Comisión de las plataformas de domicilio (Rappi, DiDi Food, Uber Eats): gasto
   * de ventas por servicios (PUC 5235). Se reconoce al liquidar, no al vender.
   */
  COMISIONES_PLATAFORMAS: '5235',
  /**
   * Comisión del adquirente (datáfono) o de la billetera: gasto financiero,
   * PUC 5305 (gastos financieros - comisiones). Se reconoce al conciliar.
   */
  COMISIONES_FINANCIERAS: '5305',
  GASTOS_DIVERSOS: '5195',
  COSTO_VENTA: '6135',
  /**
   * Costos absorbidos por la producción (ítem 1.20). La mano de obra y el
   * empaque ya están en gastos (nómina, compras); al capitalizarlos en el
   * terminado se acreditan aquí para no contarlos dos veces (NIIF Pymes 13.5 y
   * 13.8; PUC clase 7).
   */
  MANO_OBRA_ABSORBIDA: '7205',
  COSTOS_INDIRECTOS_ABSORBIDOS: '7305',
} as const;

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
  { code: '135515', name: 'Retención en la fuente a favor (anticipo)', type: 'asset' },
  { code: '135517', name: 'ReteIVA a favor (anticipo)', type: 'asset' },
  { code: '135518', name: 'ReteICA a favor (anticipo)', type: 'asset' },
  { code: '1365', name: 'Cuentas por cobrar a trabajadores', type: 'asset' },
  { code: '1435', name: 'Inventario de mercancías', type: 'asset' },
  { code: '143595', name: 'Inventario por regularizar (ventas sin conexión)', type: 'asset' },
  // Pasivo
  { code: '2205', name: 'Proveedores (CxP)', type: 'liability' },
  { code: '2365', name: 'Retención en la fuente', type: 'liability' },
  // 2367/2368 son retenciones practicadas (PUC). Se siembran con su nombre
  // real aunque el posteo automático ya no las use: las empresas anteriores
  // al cambio guardan ahí IVA/INC hasta correr la reclasificación (src/datos).
  { code: '2367', name: 'Impuesto a las ventas retenido (ReteIVA)', type: 'liability' },
  { code: '2368', name: 'Impuesto de industria y comercio retenido (ReteICA)', type: 'liability' },
  { code: '2370', name: 'Retenciones y aportes de nómina', type: 'liability' },
  { code: '2380', name: 'Propinas por pagar', type: 'liability' },
  { code: '2408', name: 'Impuesto sobre las ventas por pagar (IVA)', type: 'liability' },
  { code: '2495', name: 'Impuesto nacional al consumo por pagar', type: 'liability' },
  { code: '249510', name: 'INC de bolsas plásticas por pagar', type: 'liability' },
  { code: '2505', name: 'Salarios por pagar', type: 'liability' },
  { code: '2610', name: 'Para obligaciones laborales', type: 'liability' },
  // Patrimonio
  { code: '3105', name: 'Capital', type: 'equity' },
  { code: '3605', name: 'Resultado del ejercicio', type: 'equity' },
  // Ingresos
  { code: '4135', name: 'Ingresos por ventas', type: 'income' },
  { code: '4295', name: 'Mayor valor cobrado en plataformas', type: 'income' },
  { code: '4175', name: 'Devoluciones en ventas', type: 'income' },
  // Gastos / costos
  { code: '5105', name: 'Gastos de personal', type: 'expense' },
  { code: '5135', name: 'Servicios (arriendo, públicos)', type: 'expense' },
  { code: '5235', name: 'Comisiones de plataformas de domicilio', type: 'expense' },
  { code: '5305', name: 'Comisiones financieras (datáfono y billeteras)', type: 'expense' },
  { code: '5195', name: 'Gastos diversos', type: 'expense' },
  { code: '6135', name: 'Costo de mercancía vendida', type: 'expense' },
  // Costos de producción absorbidos (saldo crédito: restan del gasto).
  { code: '7205', name: 'Mano de obra directa absorbida', type: 'expense' },
  { code: '7305', name: 'Costos indirectos absorbidos', type: 'expense' },
];

/**
 * Cuentas que el posteo automático usó para IVA/INC hasta octubre de 2026 →
 * cuenta PUC correcta (Decreto 2650/93). 2367/2368 son ReteIVA/ReteICA; el IVA
 * por pagar es la 2408 y el INC la 2495. La usan el script de reclasificación
 * (src/datos) y la reversa de un asiento viejo, para no volver a ensuciarlas.
 */
export const RECLASIFICACIONES: readonly { desde: string; hacia: string }[] = [
  { desde: '2367', hacia: ACC.IVA_POR_PAGAR },
  { desde: '2368', hacia: ACC.INC_POR_PAGAR },
];

/**
 * `sourceType` de los asientos automáticos que llevaban el IVA/INC a 2367/2368
 * con el plan viejo. Solo en ellos 2367/2368 significan IVA/INC: en un asiento
 * manual (o de otro origen) son ReteIVA/ReteICA de verdad y no se remapean.
 */
export const ORIGENES_IVA_INC_VIEJO: readonly string[] = ['sale', 'sale_return'];

/** Código vigente de una cuenta: la PUC correcta si es una de las viejas de IVA/INC. */
export function cuentaVigente(code: string): string {
  return RECLASIFICACIONES.find((r) => r.desde === code)?.hacia ?? code;
}
