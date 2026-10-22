import { cop } from '../../finance/domain/money.util';

/**
 * Pedidos de plataformas de domicilio (ítem 7.5): Rappi, DiDi Food, Uber Eats.
 *
 * No hay integración por API: las plataformas exigen convenio de partner. Lo
 * que sí se puede es REGISTRAR sus pedidos en el POS (a mano o desde el CSV
 * que exportan los portales de aliados) para que el inventario, las ventas y
 * el libro contable los vean.
 *
 * Contablemente la plataforma cobra al cliente y le liquida al negocio después:
 * el pedido nace como cuenta por cobrar a la plataforma (1305), nunca como
 * efectivo en caja, y la comisión se reconoce como gasto al liquidar.
 */

export const PLATFORM_CODES = ['rappi', 'didi', 'uber_eats', 'otra'] as const;
export type PlatformCode = (typeof PLATFORM_CODES)[number];

export const PLATFORM_LABELS: Record<PlatformCode, string> = {
  rappi: 'Rappi',
  didi: 'DiDi Food',
  uber_eats: 'Uber Eats',
  otra: 'Otra plataforma',
};

/** Tope de pedidos por importación y de tamaño del archivo (cabe en el JSON por defecto). */
export const MAX_IMPORT_ORDERS = 200;
export const MAX_IMPORT_CHARS = 80_000;

/** Encabezados aceptados (sin tildes, en minúscula, con _) por columna lógica. */
export const CSV_ALIASES = {
  externalId: [
    'pedido', 'id_pedido', 'numero_pedido', 'codigo_pedido', 'orden', 'id_orden',
    'order', 'order_id', 'orderid', 'codigo', 'id',
  ],
  date: ['fecha', 'fecha_pedido', 'fecha_del_pedido', 'date', 'created_at'],
  name: ['producto', 'nombre_producto', 'item', 'articulo', 'product', 'descripcion', 'nombre'],
  sku: ['sku', 'referencia', 'codigo_producto', 'product_sku', 'plu'],
  qty: ['cantidad', 'qty', 'quantity', 'unidades', 'cant'],
  commission: ['comision', 'commission', 'comision_plataforma', 'fee'],
  total: ['total', 'total_pedido', 'valor_pedido', 'order_total', 'valor_total'],
  customer: ['cliente', 'customer', 'nombre_cliente'],
} as const;

export type CsvColumn = keyof typeof CSV_ALIASES;

/** Normaliza un encabezado: sin tildes, minúscula, separadores como `_`. */
export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Normaliza un nombre de producto para compararlo (sin tildes ni espacios de más). */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * CSV a filas de celdas. Acepta `,` o `;` (el Excel en español exporta con `;`),
 * comillas dobles con escape `""`, saltos de línea dentro de comillas y BOM.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM de Excel
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Monto en pesos desde el texto de un portal: "$ 12.500", "12,500.00",
 * "12.500,50". Devuelve undefined si no es un número. Siempre COP entero.
 */
export function parseAmountCop(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return undefined;
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) {
    // El último separador es el decimal; el otro es de miles.
    const dec = Math.max(dot, comma);
    s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
  } else if (dot >= 0 || comma >= 0) {
    const sep = dot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    // "12.500" / "1.234.567": grupos de 3 → miles. "12,5": decimal.
    const miles = parts.length > 2 || (parts.length === 2 && parts[1]!.length === 3);
    s = miles ? parts.join('') : parts[0] + '.' + parts[1];
  }
  const n = Number(s);
  return Number.isFinite(n) ? cop(n) : undefined;
}

/** Fecha YYYY-MM-DD desde "2026-10-05", "05/10/2026" o con hora; undefined si no se entiende. */
export function parseDateIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return undefined;
}

export interface ParsedLine {
  /** Número de línea del archivo (1 = encabezado). */
  line: number;
  name?: string;
  sku?: string;
  qty: number;
}

export interface ParsedOrder {
  externalId: string;
  orderedAt?: string;
  /** Comisión que el portal informa (estimada: la real llega al liquidar). */
  commission?: number;
  /** Total que el portal informa, para avisar si no coincide con el POS. */
  reportedTotal?: number;
  customerName?: string;
  lines: ParsedLine[];
}

export interface RowError {
  line: number;
  message: string;
}

export interface ParsedCsv {
  orders: ParsedOrder[];
  errors: RowError[];
}

/**
 * Lee el CSV del portal de aliados y agrupa las filas por pedido (una fila por
 * producto; el código del pedido se repite). Los errores son por fila y no
 * detienen el resto. Un error de encabezado (faltan columnas) devuelve el
 * error con línea 1 y ningún pedido.
 */
export function parsePlatformCsv(text: string): ParsedCsv {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { orders: [], errors: [{ line: 1, message: 'El archivo no trae pedidos' }] };
  }
  const headers = rows[0]!.map(normalizeHeader);
  const col = {} as Record<CsvColumn, number>;
  for (const key of Object.keys(CSV_ALIASES) as CsvColumn[]) {
    col[key] = headers.findIndex((h) => (CSV_ALIASES[key] as readonly string[]).includes(h));
  }
  const faltan: string[] = [];
  if (col.externalId < 0) faltan.push('código del pedido (pedido, order_id…)');
  if (col.name < 0 && col.sku < 0) faltan.push('producto o sku');
  if (col.qty < 0) faltan.push('cantidad');
  if (faltan.length > 0) {
    return {
      orders: [],
      errors: [{ line: 1, message: `Faltan columnas: ${faltan.join(', ')}` }],
    };
  }

  const cell = (r: string[], k: CsvColumn): string | undefined => {
    const i = col[k];
    const v = i >= 0 ? r[i]?.trim() : undefined;
    return v ? v : undefined;
  };
  const byId = new Map<string, ParsedOrder>();
  const errors: RowError[] = [];
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const externalId = cell(r, 'externalId');
    if (!externalId) {
      errors.push({ line, message: 'Falta el código del pedido' });
      return;
    }
    const qtyRaw = cell(r, 'qty');
    const qtyNum = qtyRaw === undefined ? NaN : Number(qtyRaw.replace(',', '.'));
    if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
      errors.push({
        line,
        message: `Cantidad inválida (${qtyRaw ?? 'vacía'}): debe ser un entero mayor que cero`,
      });
      return;
    }
    const name = cell(r, 'name');
    const sku = cell(r, 'sku');
    if (!name && !sku) {
      errors.push({ line, message: 'Falta el producto (nombre o sku)' });
      return;
    }
    let order = byId.get(externalId);
    if (!order) {
      order = { externalId, lines: [] };
      byId.set(externalId, order);
    }
    order.orderedAt ??= parseDateIso(cell(r, 'date'));
    order.customerName ??= cell(r, 'customer');
    const commission = parseAmountCop(cell(r, 'commission'));
    if (order.commission === undefined && commission !== undefined && commission >= 0) {
      order.commission = commission;
    }
    const total = parseAmountCop(cell(r, 'total'));
    if (order.reportedTotal === undefined && total !== undefined && total >= 0) {
      order.reportedTotal = total;
    }
    order.lines.push({ line, name, sku, qty: qtyNum });
  });
  return { orders: [...byId.values()], errors };
}

/** Producto vendible mínimo para emparejar una línea del CSV. */
export interface MatchableProduct {
  id: string;
  sku: string;
  name: string;
}

export type MatchResult =
  | { ok: true; productId: string; name: string }
  | { ok: false; message: string };

/** Índices por SKU y por nombre normalizado, para emparejar sin recorrer todo cada vez. */
export function indexProducts(products: readonly MatchableProduct[]) {
  const bySku = new Map<string, MatchableProduct[]>();
  const byName = new Map<string, MatchableProduct[]>();
  for (const p of products) {
    const sk = p.sku.trim().toLowerCase();
    if (sk) bySku.set(sk, [...(bySku.get(sk) ?? []), p]);
    const nm = normalizeName(p.name);
    byName.set(nm, [...(byName.get(nm) ?? []), p]);
  }
  return { bySku, byName };
}

/**
 * Empareja una línea con un producto vendible: primero por SKU exacto, luego
 * por nombre normalizado. Si hay dos candidatos es un error (no se adivina).
 */
export function matchProduct(
  line: Pick<ParsedLine, 'name' | 'sku'>,
  index: ReturnType<typeof indexProducts>,
): MatchResult {
  const probe = (list: MatchableProduct[] | undefined, what: string): MatchResult | null => {
    if (!list || list.length === 0) return null;
    if (list.length > 1) {
      return { ok: false, message: `${what} coincide con ${list.length} productos: usa el SKU` };
    }
    return { ok: true, productId: list[0]!.id, name: list[0]!.name };
  };
  if (line.sku) {
    const r = probe(index.bySku.get(line.sku.trim().toLowerCase()), `El SKU "${line.sku}"`);
    if (r) return r;
  }
  if (line.name) {
    const r = probe(index.byName.get(normalizeName(line.name)), `El nombre "${line.name}"`);
    if (r) return r;
  }
  return {
    ok: false,
    message: `No encontré el producto "${line.sku ?? line.name}" en el catálogo vendible`,
  };
}

/** Lo que una venta de plataforma le debe cobrar a la plataforma. */
export function platformReceivable(sale: { total: number; deliveryFee?: number }): number {
  return cop(sale.total + (sale.deliveryFee ?? 0));
}

export interface SettlementAmounts {
  gross: number;
  received: number;
  commission: number;
  commissionIva: number;
}

/**
 * La liquidación tiene que cuadrar: lo consignado + comisión + IVA de la
 * comisión = lo que la plataforma debía. Devuelve el motivo si no.
 */
export function validateSettlement(a: SettlementAmounts): string | null {
  for (const [k, v] of Object.entries(a)) {
    if (!Number.isInteger(v) || v < 0) return `${k} debe ser un monto entero no negativo`;
  }
  if (a.gross <= 0) return 'La liquidación no tiene nada por cobrar';
  const diff = a.gross - (a.received + a.commission + a.commissionIva);
  if (diff !== 0) {
    return diff > 0
      ? `No cuadra: faltan $${diff} (consignado + comisión + IVA de la comisión deben sumar $${a.gross})`
      : `No cuadra: sobran $${-diff} (consignado + comisión + IVA de la comisión suman más de $${a.gross})`;
  }
  return null;
}
