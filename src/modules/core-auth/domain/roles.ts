import { ALL_PERMISSIONS, PERMISSIONS, Permission } from './permissions';

/**
 * Los roles ahora viven en una colección de MongoDB (ver RolesService).
 * Un usuario tiene una clave de rol (string) + permisos extra opcionales.
 */
export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  CASHIER: 'cashier',
} as const;

/** La clave de rol es dinámica (creada por el dueño), así que es un string. */
export type Role = string;

export const ROLE_VALUES: string[] = Object.values(ROLES);

/** Permisos de gerente (heredados del rol estático anterior). */
const MANAGER_PERMISSIONS: Permission[] = [
  PERMISSIONS.SEDE_MANAGE,
  PERMISSIONS.PARAMS_MANAGE,
  PERMISSIONS.TAX_MANAGE,
  PERMISSIONS.AUDIT_VIEW,
  PERMISSIONS.POS_SELL,
  PERMISSIONS.POS_DISCOUNT_AUTHORIZE,
  PERMISSIONS.POS_VOID_AUTHORIZE,
  PERMISSIONS.POS_REFUND,
  PERMISSIONS.CAJA_OPEN,
  PERMISSIONS.CAJA_CLOSE,
  PERMISSIONS.CAJA_MOVEMENT,
  PERMISSIONS.CAJA_SANGRIA,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_ADJUST,
  PERMISSIONS.INVENTORY_TRANSFER,
  PERMISSIONS.PURCHASING_MANAGE,
  PERMISSIONS.FINANCE_VIEW,
  PERMISSIONS.FINANCE_MANAGE,
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.CUSTOMERS_VIEW,
  PERMISSIONS.CUSTOMERS_MANAGE,
];

/** Permisos de cajero (heredados del rol estático anterior). */
const CASHIER_PERMISSIONS: Permission[] = [
  PERMISSIONS.POS_SELL,
  PERMISSIONS.POS_REFUND,
  PERMISSIONS.CAJA_OPEN,
  PERMISSIONS.CAJA_CLOSE,
  PERMISSIONS.CAJA_MOVEMENT,
  PERMISSIONS.INVENTORY_VIEW,
  // El cajero registra clientes y consulta el directorio para el fiado.
  PERMISSIONS.CUSTOMERS_VIEW,
  PERMISSIONS.CUSTOMERS_MANAGE,
];

/**
 * Definiciones de los roles de sistema. Son los datos con los que se
 * siembran (seed) las filas base de la colección `roles`. La resolución
 * en tiempo de ejecución vive en RolesService (contra la DB).
 */
export const SYSTEM_ROLES: {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: true;
}[] = [
  {
    key: ROLES.OWNER,
    name: 'Dueño',
    description: 'Acceso total. Gestiona usuarios, roles y toda la operación.',
    permissions: ALL_PERMISSIONS,
    isSystem: true,
  },
  {
    key: ROLES.ADMIN,
    name: 'Administrador',
    // Como puede haber un administrador por sede, NO ve todas las sedes por
    // defecto: queda limitado a las que se le asignen (a diferencia del Dueño).
    description:
      'Acceso total a la administración, limitado a sus sedes asignadas.',
    permissions: ALL_PERMISSIONS.filter(
      (p) => p !== PERMISSIONS.SEDE_VIEW_ALL,
    ),
    isSystem: true,
  },
  {
    key: ROLES.MANAGER,
    name: 'Gerente',
    description: 'Gestiona la operación diaria de la sede.',
    permissions: MANAGER_PERMISSIONS,
    isSystem: true,
  },
  {
    key: ROLES.CASHIER,
    name: 'Cajero',
    description: 'Opera el punto de venta y la caja.',
    permissions: CASHIER_PERMISSIONS,
    isSystem: true,
  },
];
