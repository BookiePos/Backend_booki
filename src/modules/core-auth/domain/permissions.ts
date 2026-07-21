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
  SEDE_VIEW_ALL: 'sede.view_all',
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

/**
 * Catálogo agrupado con etiquetas en español para pintar la UI de roles.
 * No rompe los exports anteriores; es una vista de presentación de los permisos.
 */
export const PERMISSION_GROUPS: {
  group: string;
  label: string;
  items: { key: Permission; label: string }[];
}[] = [
  {
    group: 'admin',
    label: 'Administración',
    items: [
      { key: PERMISSIONS.USERS_MANAGE, label: 'Gestionar usuarios e invitaciones' },
      { key: PERMISSIONS.ROLES_MANAGE, label: 'Gestionar roles y permisos' },
      { key: PERMISSIONS.AUDIT_VIEW, label: 'Ver auditoría' },
      { key: PERMISSIONS.PARAMS_MANAGE, label: 'Gestionar parámetros' },
    ],
  },
  {
    group: 'sedes',
    label: 'Sedes',
    items: [
      { key: PERMISSIONS.SEDE_MANAGE, label: 'Gestionar sedes' },
      { key: PERMISSIONS.SEDE_VIEW_ALL, label: 'Ver todas las sedes' },
    ],
  },
  {
    group: 'inventory',
    label: 'Inventario y proveedores',
    items: [
      { key: PERMISSIONS.INVENTORY_VIEW, label: 'Ver inventario y proveedores' },
      { key: PERMISSIONS.INVENTORY_ADJUST, label: 'Ajustar inventario y proveedores' },
      { key: PERMISSIONS.INVENTORY_TRANSFER, label: 'Trasladar entre sedes' },
    ],
  },
  {
    group: 'pos',
    label: 'Punto de venta',
    items: [
      { key: PERMISSIONS.POS_SELL, label: 'Vender en POS' },
      { key: PERMISSIONS.POS_DISCOUNT_AUTHORIZE, label: 'Autorizar descuentos' },
      { key: PERMISSIONS.POS_VOID_AUTHORIZE, label: 'Autorizar anulaciones' },
      { key: PERMISSIONS.POS_REFUND, label: 'Devoluciones' },
    ],
  },
  {
    group: 'caja',
    label: 'Caja',
    items: [
      { key: PERMISSIONS.CAJA_OPEN, label: 'Abrir caja' },
      { key: PERMISSIONS.CAJA_CLOSE, label: 'Cerrar caja' },
      { key: PERMISSIONS.CAJA_MOVEMENT, label: 'Movimientos de caja' },
      { key: PERMISSIONS.CAJA_SANGRIA, label: 'Sangrías' },
    ],
  },
  {
    group: 'finance',
    label: 'Compras y finanzas',
    items: [
      { key: PERMISSIONS.PURCHASING_MANAGE, label: 'Gestionar compras' },
      { key: PERMISSIONS.FINANCE_VIEW, label: 'Ver finanzas' },
      { key: PERMISSIONS.REPORTS_VIEW, label: 'Ver reportes' },
      { key: PERMISSIONS.TAX_MANAGE, label: 'Gestionar impuestos' },
    ],
  },
];
