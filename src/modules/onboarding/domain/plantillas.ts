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
 * incluido). NO traen costo: el costo real lo da la primera compra o el
 * inventario inicial de la persona; inventar uno ensuciaría la valorización.
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

/**
 * Existencias de ejemplo de cada ítem. El POS no vende con stock 0, así que sin
 * ellas la primera venta toparía. Entran SIN costo y con el tipo de movimiento
 * `sample`: no son una compra, no tienen asiento y no valorizan el inventario.
 */
export const STOCK_INICIAL = 30;

const g = (
  nombre: string,
  precio: number,
  extra: Partial<ItemPlantilla> = {},
): ItemPlantilla => ({ nombre, precio, iva: 19, ...extra });
/** Preparado y servido en el lugar. */
const s = (nombre: string, precio: number): ItemPlantilla =>
  g(nombre, precio, { servido: true });
/** Excluido de IVA (canasta básica, pan). */
const ex = (nombre: string, precio: number): ItemPlantilla =>
  g(nombre, precio, { iva: 0, ivaTipo: 'excluido' });
/** Exento (tarifa 0 %, con derecho a descuento): leche y huevos, art. 477 ET. */
const ext = (nombre: string, precio: number): ItemPlantilla =>
  g(nombre, precio, { iva: 0, ivaTipo: 'exento' });
/** IVA reducido del 5 %. */
const r5 = (nombre: string, precio: number): ItemPlantilla =>
  g(nombre, precio, { iva: 5 });

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
          s('Empanadas x3', 7500),
          s('Patacones con hogao', 9500),
          s('Sopa del día', 12000),
        ],
      },
      {
        nombre: 'Platos fuertes',
        items: [
          s('Almuerzo ejecutivo', 18000),
          s('Bandeja paisa', 28000),
          s('Pechuga a la plancha', 24000),
          s('Lomo de res', 29000),
          s('Mojarra frita', 27000),
        ],
      },
      {
        nombre: 'Bebidas',
        items: [
          s('Jugo natural', 6500),
          s('Limonada', 5500),
          s('Gaseosa 400 ml', 3500),
          s('Agua en botella', 3000),
        ],
      },
      {
        nombre: 'Postres',
        items: [s('Postre del día', 8000), s('Helado de la casa', 6000)],
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
          s('Hamburguesa clásica', 16000),
          s('Hamburguesa doble carne', 22000),
          s('Combo hamburguesa', 24000),
        ],
      },
      {
        nombre: 'Rápidas',
        items: [
          s('Perro caliente', 12000),
          s('Salchipapa', 14000),
          s('Pizza personal', 15000),
          s('Papas a la francesa', 7000),
        ],
      },
      {
        nombre: 'Bebidas',
        items: [
          s('Gaseosa 400 ml', 3500),
          s('Agua en botella', 3000),
          s('Jugo en agua', 5500),
          s('Malteada', 9000),
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
          s('Tinto', 2500),
          s('Café americano', 4000),
          s('Capuchino', 6500),
          s('Latte', 7000),
          s('Chocolate caliente', 6000),
          s('Aromática', 3500),
        ],
      },
      {
        nombre: 'Bebidas frías',
        items: [
          s('Jugo natural', 6500),
          s('Gaseosa 400 ml', 3500),
          s('Agua en botella', 3000),
        ],
      },
      {
        nombre: 'Para comer',
        items: [
          s('Sándwich de jamón y queso', 11000),
          s('Croissant de jamón y queso', 8500),
          s('Torta (porción)', 7000),
          s('Galleta', 3000),
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
          ex('Pan francés (unidad)', 500),
          ex('Pan tajado (bolsa)', 5800),
          ex('Pan integral (bolsa)', 7200),
          ex('Mogolla integral', 1800),
        ],
      },
      {
        nombre: 'Pastelería',
        items: [
          g('Torta (porción)', 6500),
          g('Pastel de pollo', 4500),
          g('Croissant', 4000),
          g('Galleta de mantequilla', 2500),
          g('Roscón', 3500),
        ],
      },
      {
        nombre: 'Bebidas y lácteos',
        items: [
          s('Tinto', 2000),
          s('Café con leche', 3500),
          ext('Leche entera 1 L', 4700),
          g('Gaseosa 400 ml', 3500),
          g('Jugo en caja', 3000),
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
          ex('Arroz 1 kg', 4800),
          ex('Lentejas 500 g', 3600),
          ex('Panela 500 g', 3200),
          r5('Azúcar 1 kg', 4900),
          r5('Café molido 250 g', 7800),
          r5('Chocolate de mesa 250 g', 6500),
        ],
      },
      {
        nombre: 'Lácteos y huevos',
        items: [ext('Leche entera 1 L', 4700), ext('Huevos AA x12', 8400)],
      },
      {
        nombre: 'Frutas y verduras',
        items: [
          ex('Papa (kg)', 3200),
          ex('Tomate (kg)', 4500),
          ex('Cebolla (kg)', 3800),
          ex('Plátano verde (unidad)', 1200),
        ],
      },
      {
        nombre: 'Bebidas',
        items: [
          g('Gaseosa 1,5 L', 5800),
          g('Agua 600 ml', 2500),
          g('Jugo en caja 1 L', 4800),
        ],
      },
      {
        nombre: 'Snacks',
        items: [
          g('Papas fritas de paquete', 3000),
          g('Galletas de paquete', 2500),
          g('Chocolatina', 2000),
        ],
      },
      {
        nombre: 'Aseo',
        items: [
          g('Jabón de baño', 3500),
          g('Detergente 1 kg', 11500),
          g('Papel higiénico x4', 7500),
        ],
      },
    ],
  },
];

/**
 * Plantillas de comida preparada: su gracia es lo servido, que solo tiene
 * sentido como expendio con INC. En una empresa retail quedaría gravado con IVA
 * 19, que es el tratamiento equivocado, así que se rechazan.
 */
export const SOLO_RESTAURANTE: readonly TipoPlantilla[] = [
  'restaurante',
  'comidas_rapidas',
  'cafeteria',
];

/** Motivo por el que una plantilla no aplica al giro, o `null` si aplica. */
export function motivoNoAplica(tipo: TipoPlantilla, giro: BusinessType): string | null {
  if (giro === 'retail' && SOLO_RESTAURANTE.includes(tipo)) {
    return 'Esta plantilla es de comida preparada y tu negocio está registrado como tienda (retail): lo servido llevaría IVA en vez de impuesto al consumo. Usa «Panadería» o «Tienda», o cambia el tipo de negocio a restaurante.';
  }
  return null;
}

/** En retail no se siembra lo servido (va con el giro restaurante). */
export function seSiembra(item: ItemPlantilla, giro: BusinessType): boolean {
  return !(giro === 'retail' && item.servido);
}

/** SKU de plantilla: solo los prefijos conocidos, no cualquier `PL-XXX-1` del usuario. */
export const REGEX_SKU_PLANTILLA = new RegExp(
  '^PL-(' + PLANTILLAS.map((p) => p.prefijo).join('|') + ')-\\d{2}$',
);

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
