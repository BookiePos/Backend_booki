import type { BusinessType } from '../../control/domain/control.constants';
import type {
  IvaRate,
  IvaType,
  TratamientoFiscal,
} from '../../catalog/domain/catalog.constants';

/**
 * Plantillas de arranque (ítem 6.6): un menú o catálogo de ejemplo por tipo de
 * negocio, para vender en minutos. Son DATOS puros: nada de Nest ni Mongoose.
 *
 * Todo es editable o borrable después; la plantilla solo ahorra la página en
 * blanco. Los precios son de referencia (COP, entero, con el impuesto
 * incluido) y los costos sirven para que los reportes de margen no salgan en 0.
 */

export const TIPOS_PLANTILLA = [
  'restaurante',
  'comidas_rapidas',
  'cafeteria',
  'panaderia',
  'tienda',
] as const;
export type TipoPlantilla = (typeof TIPOS_PLANTILLA)[number];

export interface ItemPlantilla {
  nombre: string;
  /** Precio de venta al público, COP entero, impuesto incluido. */
  precio: number;
  /** Costo de referencia por unidad, COP entero. */
  costo: number;
  /** Tarifa de IVA del BIEN (0/5/19). */
  iva: IvaRate;
  /** Tratamiento de IVA del bien; sin dato, gravado (o exento si la tarifa es 0). */
  ivaTipo?: IvaType;
  /**
   * Se prepara y se sirve en el lugar (expendio). En un restaurante eso lleva
   * INC y no IVA; lo que se revende empacado (gaseosa, agua) lleva el IVA del
   * bien. Es la distinción de `saleTaxFor`.
   */
  servido?: boolean;
}

export interface CategoriaPlantilla {
  nombre: string;
  items: ItemPlantilla[];
}

export interface Plantilla {
  tipo: TipoPlantilla;
  nombre: string;
  descripcion: string;
  /** Prefijo del SKU: PL-<prefijo>-NN. Identifica lo sembrado por esta plantilla. */
  prefijo: string;
  categorias: CategoriaPlantilla[];
  /** Mesas a crear (solo negocios con salón). */
  mesas?: { cantidad: number; zona: string; puestos: number };
}

/** Existencias iniciales de cada ítem, para que la primera venta no tope con stock 0. */
export const STOCK_INICIAL = 30;

const g = (
  nombre: string,
  precio: number,
  costo: number,
  extra: Partial<ItemPlantilla> = {},
): ItemPlantilla => ({ nombre, precio, costo, iva: 19, ...extra });
/** Preparado y servido en el lugar. */
const s = (nombre: string, precio: number, costo: number): ItemPlantilla =>
  g(nombre, precio, costo, { servido: true });
/** Excluido de IVA (canasta básica, pan). */
const ex = (nombre: string, precio: number, costo: number): ItemPlantilla =>
  g(nombre, precio, costo, { iva: 0, ivaTipo: 'excluido' });
/** IVA reducido del 5 %. */
const r5 = (nombre: string, precio: number, costo: number): ItemPlantilla =>
  g(nombre, precio, costo, { iva: 5 });

export const PLANTILLAS: Plantilla[] = [
  {
    tipo: 'restaurante',
    nombre: 'Restaurante',
    descripcion: 'Entradas, platos fuertes, bebidas y postres, con 8 mesas en el salón.',
    prefijo: 'REST',
    mesas: { cantidad: 8, zona: 'Salón', puestos: 4 },
    categorias: [
      {
        nombre: 'Entradas',
        items: [
          s('Empanadas x3', 7500, 2600),
          s('Patacones con hogao', 9500, 3000),
          s('Sopa del día', 12000, 3800),
        ],
      },
      {
        nombre: 'Platos fuertes',
        items: [
          s('Almuerzo ejecutivo', 18000, 6500),
          s('Bandeja paisa', 28000, 10500),
          s('Pechuga a la plancha', 24000, 8500),
          s('Lomo de res', 29000, 12000),
          s('Mojarra frita', 27000, 11000),
        ],
      },
      {
        nombre: 'Bebidas',
        items: [
          s('Jugo natural', 6500, 1800),
          s('Limonada', 5500, 1200),
          g('Gaseosa 400 ml', 3500, 2000),
          g('Agua en botella', 3000, 1300),
        ],
      },
      {
        nombre: 'Postres',
        items: [s('Postre del día', 8000, 2500), s('Helado de la casa', 6000, 1800)],
      },
    ],
  },
  {
    tipo: 'comidas_rapidas',
    nombre: 'Comidas rápidas',
    descripcion: 'Hamburguesas, perros, pizza, combos y bebidas.',
    prefijo: 'RAP',
    categorias: [
      {
        nombre: 'Hamburguesas',
        items: [
          s('Hamburguesa clásica', 16000, 5500),
          s('Hamburguesa doble carne', 22000, 8500),
          s('Combo hamburguesa', 24000, 8800),
        ],
      },
      {
        nombre: 'Rápidas',
        items: [
          s('Perro caliente', 12000, 4000),
          s('Salchipapa', 14000, 4800),
          s('Pizza personal', 15000, 5000),
          s('Papas a la francesa', 7000, 1800),
        ],
      },
      {
        nombre: 'Bebidas',
        items: [
          g('Gaseosa 400 ml', 3500, 2000),
          g('Agua en botella', 3000, 1300),
          s('Jugo en agua', 5500, 1500),
          s('Malteada', 9000, 3000),
        ],
      },
    ],
  },
  {
    tipo: 'cafeteria',
    nombre: 'Cafetería',
    descripcion: 'Café, bebidas calientes y frías, sándwiches y repostería, con 6 mesas.',
    prefijo: 'CAF',
    mesas: { cantidad: 6, zona: 'Salón', puestos: 2 },
    categorias: [
      {
        nombre: 'Café y bebidas calientes',
        items: [
          s('Tinto', 2500, 500),
          s('Café americano', 4000, 900),
          s('Capuchino', 6500, 1700),
          s('Latte', 7000, 1900),
          s('Chocolate caliente', 6000, 1800),
          s('Aromática', 3500, 600),
        ],
      },
      {
        nombre: 'Bebidas frías',
        items: [
          s('Jugo natural', 6500, 1800),
          g('Gaseosa 400 ml', 3500, 2000),
          g('Agua en botella', 3000, 1300),
        ],
      },
      {
        nombre: 'Para comer',
        items: [
          s('Sándwich de jamón y queso', 11000, 4000),
          s('Croissant de jamón y queso', 8500, 3200),
          s('Torta (porción)', 7000, 2200),
          s('Galleta', 3000, 900),
        ],
      },
    ],
  },
  {
    tipo: 'panaderia',
    nombre: 'Panadería',
    descripcion: 'Pan, pastelería, lácteos y café para llevar.',
    prefijo: 'PAN',
    categorias: [
      {
        nombre: 'Pan',
        items: [
          ex('Pan francés (unidad)', 500, 200),
          ex('Pan tajado (bolsa)', 5800, 3900),
          ex('Pan integral (bolsa)', 7200, 4800),
          ex('Mogolla integral', 1800, 800),
        ],
      },
      {
        nombre: 'Pastelería',
        items: [
          g('Torta (porción)', 6500, 2200),
          g('Pastel de pollo', 4500, 1800),
          g('Croissant', 4000, 1500),
          g('Galleta de mantequilla', 2500, 900),
          g('Roscón', 3500, 1300),
        ],
      },
      {
        nombre: 'Bebidas y lácteos',
        items: [
          s('Tinto', 2000, 400),
          s('Café con leche', 3500, 900),
          ex('Leche entera 1 L', 4700, 3900),
          g('Gaseosa 400 ml', 3500, 2000),
          g('Jugo en caja', 3000, 1700),
        ],
      },
    ],
  },
  {
    tipo: 'tienda',
    nombre: 'Tienda o minimercado',
    descripcion: 'Despensa, lácteos, frutas y verduras, bebidas, snacks y aseo.',
    prefijo: 'TND',
    categorias: [
      {
        nombre: 'Despensa',
        items: [
          ex('Arroz 1 kg', 4800, 3900),
          ex('Lentejas 500 g', 3600, 2800),
          ex('Panela 500 g', 3200, 2500),
          r5('Azúcar 1 kg', 4900, 4000),
          r5('Café molido 250 g', 7800, 6200),
          r5('Chocolate de mesa 250 g', 6500, 5200),
        ],
      },
      {
        nombre: 'Lácteos y huevos',
        items: [ex('Leche entera 1 L', 4700, 3900), ex('Huevos AA x12', 8400, 7000)],
      },
      {
        nombre: 'Frutas y verduras',
        items: [
          ex('Papa (kg)', 3200, 2400),
          ex('Tomate (kg)', 4500, 3400),
          ex('Cebolla (kg)', 3800, 2900),
          ex('Plátano verde (unidad)', 1200, 800),
        ],
      },
      {
        nombre: 'Bebidas',
        items: [
          g('Gaseosa 1,5 L', 5800, 4500),
          g('Agua 600 ml', 2500, 1500),
          g('Jugo en caja 1 L', 4800, 3600),
        ],
      },
      {
        nombre: 'Snacks',
        items: [
          g('Papas fritas de paquete', 3000, 2100),
          g('Galletas de paquete', 2500, 1700),
          g('Chocolatina', 2000, 1400),
        ],
      },
      {
        nombre: 'Aseo',
        items: [
          g('Jabón de baño', 3500, 2400),
          g('Detergente 1 kg', 11500, 8800),
          g('Papel higiénico x4', 7500, 5600),
        ],
      },
    ],
  },
];

export function plantillaDe(tipo: string): Plantilla | undefined {
  return PLANTILLAS.find((p) => p.tipo === tipo);
}

export interface ItemSembrado extends ItemPlantilla {
  sku: string;
  categoria: string;
}

/** SKU estable de cada ítem: PL-<prefijo>-NN, en el orden de la plantilla. */
export function itemsDe(plantilla: Plantilla): ItemSembrado[] {
  let n = 0;
  return plantilla.categorias.flatMap((c) =>
    c.items.map((it) => ({
      ...it,
      categoria: c.nombre,
      sku: `PL-${plantilla.prefijo}-${String(++n).padStart(2, '0')}`,
    })),
  );
}

export interface FiscalDelItem {
  ivaRate: IvaRate;
  ivaType: IvaType;
  tratamientoFiscal?: TratamientoFiscal;
  /** Qué terminará cobrando la venta (informativo; la decide `saleTaxFor`). */
  efecto: 'inc' | 'iva' | 'excluido';
}

/**
 * Impuesto con el que nace cada ítem según el giro de la empresa.
 *
 * - Restaurante: lo servido es expendio (no lleva IVA; el INC lo pone la venta
 *   con el perfil fiscal de la sede, así que la tarifa no se escribe aquí). Lo
 *   que se revende empacado queda como mercancía con el IVA del bien.
 * - Retail: el IVA del bien.
 */
export function fiscalDe(item: ItemPlantilla, giro: BusinessType): FiscalDelItem {
  if (giro === 'restaurante' && item.servido) {
    return { ivaRate: 0, ivaType: 'excluido', tratamientoFiscal: 'expendio', efecto: 'inc' };
  }
  const ivaType: IvaType = item.ivaTipo ?? (item.iva === 0 ? 'exento' : 'gravado');
  return {
    ivaRate: item.iva,
    ivaType,
    tratamientoFiscal: giro === 'restaurante' ? 'mercancia' : undefined,
    efecto: ivaType === 'excluido' ? 'excluido' : 'iva',
  };
}
