/**
 * Catálogo comercial de planes GoCheck (control-plane). Fuente ÚNICA de la
 * verdad para precios, cuotas, features por plan y complementos. La web de
 * precios, el registro y el gating (backend + frontend) leen de aquí.
 *
 * Montos en COP entero (sin decimales), como el resto del núcleo financiero.
 */

/** Planes comercializados. */
export const BUSINESS_PLANS = ['punto', 'negocio', 'control', 'cadena'] as const;
export type BusinessPlan = (typeof BUSINESS_PLANS)[number];

/**
 * Features gateables por plan. Son ORTOGONALES a los permisos RBAC: aunque el
 * Dueño tenga todos los permisos, si su plan no incluye la feature, la función
 * se oculta (UI) y se bloquea (API 402).
 */
export const PLAN_FEATURES = {
  // Base — incluidas en todos los planes
  POS: 'pos',
  INVENTORY: 'inventory',
  CAJA: 'caja',
  CUSTOMERS: 'customers',
  REPORTS: 'reports',
  EINVOICING: 'einvoicing',
  // Negocio en adelante
  RESTAURANT: 'restaurant',
  LOTS: 'lots',
  PURCHASING: 'purchasing',
  EXPENSES: 'expenses',
  // Control en adelante
  ACCOUNTING: 'accounting',
  AUDIT: 'audit',
  // Cadena
  MULTI_SEDE: 'multi_sede',
  TRANSFERS: 'transfers',
  ROLES_PER_SEDE: 'roles_per_sede',
  // Complemento
  PAYROLL: 'payroll',
} as const;
export type PlanFeature = (typeof PLAN_FEATURES)[keyof typeof PLAN_FEATURES];

const BASE_FEATURES: PlanFeature[] = [
  PLAN_FEATURES.POS,
  PLAN_FEATURES.INVENTORY,
  PLAN_FEATURES.CAJA,
  PLAN_FEATURES.CUSTOMERS,
  PLAN_FEATURES.REPORTS,
  PLAN_FEATURES.EINVOICING,
];
const NEGOCIO_FEATURES: PlanFeature[] = [
  ...BASE_FEATURES,
  PLAN_FEATURES.RESTAURANT,
  PLAN_FEATURES.LOTS,
  PLAN_FEATURES.PURCHASING,
  PLAN_FEATURES.EXPENSES,
];
const CONTROL_FEATURES: PlanFeature[] = [
  ...NEGOCIO_FEATURES,
  PLAN_FEATURES.ACCOUNTING,
  PLAN_FEATURES.AUDIT,
  PLAN_FEATURES.PAYROLL,
];
const CADENA_FEATURES: PlanFeature[] = [
  ...CONTROL_FEATURES,
  PLAN_FEATURES.MULTI_SEDE,
  PLAN_FEATURES.TRANSFERS,
  PLAN_FEATURES.ROLES_PER_SEDE,
];

export const PLAN_FEATURES_BY_PLAN: Record<BusinessPlan, PlanFeature[]> = {
  punto: BASE_FEATURES,
  negocio: NEGOCIO_FEATURES,
  control: CONTROL_FEATURES,
  cadena: CADENA_FEATURES,
};

/** Cuota `null` = ilimitado. */
export interface PlanQuotas {
  sedes: number;
  users: number | null;
  documentsPerMonth: number;
  payrollEmployees: number;
}

export const PLAN_QUOTAS: Record<BusinessPlan, PlanQuotas> = {
  punto: { sedes: 1, users: 3, documentsPerMonth: 400, payrollEmployees: 0 },
  negocio: { sedes: 1, users: null, documentsPerMonth: 2_000, payrollEmployees: 0 },
  control: { sedes: 1, users: null, documentsPerMonth: 5_000, payrollEmployees: 10 },
  cadena: { sedes: 3, users: null, documentsPerMonth: 12_000, payrollEmployees: 25 },
};

export interface PlanPricing {
  monthly: number;
  annual: number;
}
export const PLAN_PRICING: Record<BusinessPlan, PlanPricing> = {
  punto: { monthly: 49_900, annual: 499_000 },
  negocio: { monthly: 119_900, annual: 1_199_000 },
  control: { monthly: 229_900, annual: 2_299_000 },
  cadena: { monthly: 449_900, annual: 4_499_000 },
};

export interface PlanMeta {
  name: string;
  pitch: string;
}
export const PLAN_META: Record<BusinessPlan, PlanMeta> = {
  punto: { name: 'Punto', pitch: 'Tienda, cafetería, panadería, peluquería. Un local, sin contador de planta.' },
  negocio: { name: 'Negocio', pitch: 'Restaurante, minimercado, ferretería. Compra a proveedores y maneja mermas.' },
  control: { name: 'Control', pitch: 'Pyme formal con contador. Necesita estados financieros, no solo reportes de venta.' },
  cadena: { name: 'Cadena', pitch: 'Dos o más locales con inventario y caja consolidados.' },
};

/** Complementos (add-ons) comercializados aparte del plan base. */
export interface AddOnMeta {
  id: string;
  name: string;
  price: number;
  unit: string;
  note?: string;
}
export const ADD_ONS: Record<string, AddOnMeta> = {
  payroll: { id: 'payroll', name: 'Nómina hasta 10 empleados', price: 34_900, unit: '/mes', note: 'Incluida en Control y Cadena.' },
  extraEmployee: { id: 'extraEmployee', name: 'Empleado adicional', price: 2_900, unit: '/mes' },
  extraSede: { id: 'extraSede', name: 'Sede adicional', price: 89_900, unit: '/mes', note: 'Sobre Cadena, sin límite de sedes.' },
  docPackage: { id: 'docPackage', name: 'Paquete de 1.000 documentos', price: 29_900, unit: 'único', note: 'No expira. Se consume solo al pasar el cupo del plan.' },
  migration: { id: 'migration', name: 'Migración desde Siigo, Alegra o Excel', price: 0, unit: 'sin costo', note: 'El importador de catálogo y existencias por CSV ya está construido.' },
  training: { id: 'training', name: 'Capacitación adicional en sitio', price: 180_000, unit: '/sesión', note: 'Por sesión, solo Bogotá.' },
};

/** Complementos contratados por una empresa (se guardan en el control-plane). */
export interface BusinessAddOns {
  /** Habilita el módulo de nómina (10 empleados base). */
  payroll?: boolean;
  /** Sedes compradas por encima del plan. */
  extraSedes?: number;
  /** Empleados de nómina adicionales al tope del plan/complemento. */
  extraEmployees?: number;
  /** Paquetes de 1.000 documentos comprados. */
  docPackages?: number;
}

export interface Entitlements {
  plan: BusinessPlan;
  features: PlanFeature[];
  quotas: PlanQuotas;
}

/** Empleados que habilita el complemento de nómina. */
const PAYROLL_ADDON_EMPLOYEES = 10;
/** Documentos por paquete comprado. */
const DOCS_PER_PACKAGE = 1_000;

/**
 * Normaliza un id de plan crudo (BD/token) a uno vigente. Los registros
 * heredados con el plan viejo `operacion` (el tope anterior) se mapean a
 * `cadena`; cualquier valor desconocido cae también a `cadena` (fail-open: no
 * dejamos sin funciones a una empresa por un dato raro).
 */
export function normalizePlan(raw?: string | null): BusinessPlan {
  if (raw && (BUSINESS_PLANS as readonly string[]).includes(raw)) {
    return raw as BusinessPlan;
  }
  return 'cadena';
}

/** Entitlements efectivos = plan base + complementos contratados. */
export function effectiveEntitlements(
  rawPlan?: string | null,
  addOns?: BusinessAddOns,
): Entitlements {
  const plan = normalizePlan(rawPlan);
  const features = new Set<PlanFeature>(PLAN_FEATURES_BY_PLAN[plan]);
  const quotas: PlanQuotas = { ...PLAN_QUOTAS[plan] };

  if (addOns?.payroll) {
    features.add(PLAN_FEATURES.PAYROLL);
    if (quotas.payrollEmployees < PAYROLL_ADDON_EMPLOYEES) {
      quotas.payrollEmployees = PAYROLL_ADDON_EMPLOYEES;
    }
  }
  if (addOns?.extraEmployees && addOns.extraEmployees > 0) {
    quotas.payrollEmployees += addOns.extraEmployees;
  }
  if (addOns?.extraSedes && addOns.extraSedes > 0) {
    quotas.sedes += addOns.extraSedes;
  }
  if (addOns?.docPackages && addOns.docPackages > 0) {
    quotas.documentsPerMonth += addOns.docPackages * DOCS_PER_PACKAGE;
  }

  return { plan, features: [...features], quotas };
}

export function planHasFeature(
  entitlements: Entitlements,
  feature: PlanFeature,
): boolean {
  return entitlements.features.includes(feature);
}
