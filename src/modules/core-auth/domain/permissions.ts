/**
 * Catálogo de permisos granulares del ERP.
 * Cada permiso es una cadena estable `modulo.accion`. Los roles se componen
 * de estos permisos (ver roles.ts) y un usuario puede recibir permisos extra.
 */
export const PERMISSIONS = {
  // Núcleo / administración
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  SEDE_MANAGE: 'sede.manage',
  PARAMS_MANAGE: 'params.manage',
  TAX_MANAGE: 'tax.manage',
  AUDIT_VIEW: 'audit.view',
  // POS / ventas
  POS_SELL: 'pos.sell',
  POS_DISCOUNT_AUTHORIZE: 'pos.discount.authorize',
  POS_VOID_AUTHORIZE: 'pos.void.authorize',
  POS_REFUND: 'pos.refund',
  // Caja
  CAJA_OPEN: 'caja.open',
  CAJA_CLOSE: 'caja.close',
  CAJA_MOVEMENT: 'caja.movement',
  CAJA_SANGRIA: 'caja.sangria',
  // Inventario
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_TRANSFER: 'inventory.transfer',
  // Compras / finanzas / reportes
  PURCHASING_MANAGE: 'purchasing.manage',
  FINANCE_VIEW: 'finance.view',
  REPORTS_VIEW: 'reports.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);
