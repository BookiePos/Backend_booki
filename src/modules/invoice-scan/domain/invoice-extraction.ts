/**
 * Contrato de lo que un modelo de IA extrae de la foto de una factura, y el
 * parser defensivo que lo normaliza.
 *
 * **Todos los campos son opcionales a propósito.** El modelo se equivoca, lee a
 * medias y a veces devuelve JSON incompleto. Un campo ausente lo corrige la
 * persona en la pantalla de revisión; un campo inventado se cuela hasta la
 * contabilidad. Por eso aquí nada se rellena "a la fuerza": lo que no se
 * entiende se descarta.
 *
 * Dominio puro: sin Nest, sin Mongoose, testeable sin red.
 */

export type PaymentTerms = 'contado' | 'credito';

export interface ExtractedSupplier {
  name?: string;
  /** NIT/CC sin puntos ni guiones ni dígito de verificación. */
  docNumber?: string;
  docType?: 'NIT' | 'CC' | 'CE';
  phone?: string;
  address?: string;
  city?: string;
}

export interface ExtractedInvoiceMeta {
  number?: string;
  /** YYYY-MM-DD. */
  issueDate?: string;
  dueDate?: string;
  paymentTerms?: PaymentTerms;
}

export interface ExtractedLine {
  description: string;
  qty?: number;
  unit?: string;
  unitCost?: number;
  discount?: number;
  /** Tarifa de IVA de la línea: 0, 5 o 19. */
  ivaRate?: number;
  lineTotal?: number;
  /** Código/referencia del proveedor para esta línea. */
  code?: string;
  /** Código de barras si la factura lo imprime. */
  barcode?: string;
}

export interface ExtractedTotals {
  subtotal?: number;
  iva?: number;
  /** Retenciones leídas. Hoy no se registran: se conservan para no perder el dato. */
  retentions?: number;
  total?: number;
}

export interface ExtractedInvoice {
  supplier: ExtractedSupplier;
  invoice: ExtractedInvoiceMeta;
  lines: ExtractedLine[];
  totals: ExtractedTotals;
}

/** Documento vacío: lo que se devuelve cuando no se entiende nada. */
export function emptyInvoice(): ExtractedInvoice {
  return { supplier: {}, invoice: {}, lines: [], totals: {} };
}

// ─── Números ────────────────────────────────────────────────────────────────

/**
 * Interpreta un importe escrito como lo escriben aquí: `1.234.567`,
 * `1.234.567,89`, y también el formato anglosajón `1,234,567.89` que algunos
 * proveedores imprimen.
 *
 * La regla: **el último separador manda**. Si va seguido de exactamente tres
 * dígitos y hay más de un separador del mismo tipo, es de miles; si no, es
 * decimal. Un `$` o un `COP` delante no estorban.
 */
export function parseAmount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;

  const clean = value.replace(/[^\d.,-]/g, '').trim();
  if (!clean || !/\d/.test(clean)) return undefined;

  const decimalPos = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf(','));
  let normalized: string;

  if (decimalPos === -1) {
    normalized = clean;
  } else if (clean.length - decimalPos - 1 === 3) {
    // Tres dígitos tras el último separador: es de miles. "1.500" son mil
    // quinientos pesos, no uno con medio.
    normalized = clean.replace(/[.,]/g, '');
  } else {
    const intPart = clean.slice(0, decimalPos).replace(/[.,]/g, '');
    normalized = `${intPart}.${clean.slice(decimalPos + 1)}`;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Importe en pesos: entero y nunca negativo (el repo trabaja en COP entero).
 *
 * Con una red de seguridad que vale la pena explicar. Si el modelo devuelve el
 * importe como NÚMERO en vez de como texto, `JSON.parse` ya destrozó el dato
 * antes de que llegue aquí: `4.450` (cuatro mil cuatrocientos cincuenta) se
 * convierte en 4,45, y el Gatorade de la factura pasa a costar cuatro pesos.
 *
 * En este sistema el peso colombiano **no usa centavos** (ver
 * `finance/domain/money.util.ts`), así que un importe con decimales no es un
 * precio: es un separador de miles mal interpretado. Se multiplica por mil y se
 * recupera el valor real. El prompt ya pide los importes como texto; esto es
 * para cuando el modelo no obedezca, que pasa.
 */
export function parseCop(value: unknown): number | undefined {
  const amount = parseAmount(value);
  if (amount === undefined) return undefined;
  const real = Number.isInteger(amount) ? amount : amount * 1000;
  return Math.max(0, Math.round(real));
}

/** Cantidad: admite decimales (2,5 kg) pero nunca negativa ni cero. */
export function parseQty(value: unknown): number | undefined {
  const qty = parseAmount(value);
  if (qty === undefined || qty <= 0) return undefined;
  return qty;
}

// ─── Fechas ─────────────────────────────────────────────────────────────────

/**
 * Normaliza a `YYYY-MM-DD`. Acepta lo que imprimen las facturas colombianas:
 * `2026-08-30`, `30/08/2026`, `30-08-26`. **Día primero**, que es como se
 * escribe aquí; interpretarlo al revés convierte el 3 de agosto en el 8 de marzo.
 */
export function parseDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    return validDate(Number(year), Number(month), Number(day));
  }

  const dmy = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})/.exec(text);
  if (dmy) {
    const [, day, month, rawYear] = dmy;
    const year = Number(rawYear) < 100 ? 2000 + Number(rawYear) : Number(rawYear);
    return validDate(year, Number(month), Number(day));
  }
  return undefined;
}

function validDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (year < 2000 || year > 2100) return undefined;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// ─── Documento de identidad ─────────────────────────────────────────────────

/**
 * Deja el NIT en dígitos, sin puntos ni el dígito de verificación.
 * `900.123.456-7` → `900123456`. Así empareja con lo que haya guardado el
 * usuario, que puede haberlo escrito de cualquiera de las dos formas.
 */
export function normalizeDocNumber(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  // El guion final con un dígito es el DV y sobra ("900.123.456-7" → 900123456).
  // Sin guion no se toca nada: una cédula "1020304050" está completa.
  const digits = text.replace(/-\s*\d\s*$/, '').replace(/\D/g, '');
  return digits.length >= 5 ? digits : undefined;
}

// ─── Parser defensivo ───────────────────────────────────────────────────────

const IVA_RATES = [0, 5, 19];

function str(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : undefined;
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const found = Object.keys(source).find(
      (k) => k.toLowerCase().replace(/[\s_-]/g, '') === key,
    );
    if (found !== undefined && source[found] !== null) return source[found];
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Convierte la respuesta cruda del modelo en un `ExtractedInvoice`.
 *
 * Tolera nombres de campo distintos (cada modelo bautiza las claves a su
 * manera), objetos anidados, nulos y basura suelta. Nunca lanza: si no
 * entiende nada devuelve un documento vacío, que la pantalla de revisión
 * muestra como "no se pudo leer" en vez de reventar la petición.
 */
export function parseExtractedInvoice(raw: unknown): ExtractedInvoice {
  const root = asObject(raw);
  const supplierRaw = asObject(
    pick(root, 'supplier', 'proveedor', 'vendor', 'emisor'),
  );
  const invoiceRaw = asObject(
    pick(root, 'invoice', 'factura', 'document', 'documento'),
  );
  const totalsRaw = asObject(pick(root, 'totals', 'totales', 'summary'));

  const docNumber = normalizeDocNumber(
    pick(supplierRaw, 'docnumber', 'nit', 'documento', 'identificacion', 'taxid'),
  );
  const docTypeRaw = str(pick(supplierRaw, 'doctype', 'tipodocumento'), 10);
  const docType =
    docTypeRaw && ['NIT', 'CC', 'CE'].includes(docTypeRaw.toUpperCase())
      ? (docTypeRaw.toUpperCase() as 'NIT' | 'CC' | 'CE')
      : docNumber
        ? 'NIT'
        : undefined;

  const termsRaw = str(
    pick(invoiceRaw, 'paymentterms', 'formapago', 'condicionpago'),
    30,
  )?.toLowerCase();
  const paymentTerms: PaymentTerms | undefined = termsRaw
    ? /cr[eé]dito|credit|plazo/.test(termsRaw)
      ? 'credito'
      : /contado|cash|efectivo/.test(termsRaw)
        ? 'contado'
        : undefined
    : undefined;

  const linesRaw = pick(root, 'lines', 'lineas', 'items', 'detalle', 'productos');

  return {
    supplier: {
      name: str(pick(supplierRaw, 'name', 'nombre', 'razonsocial')),
      docNumber,
      docType,
      phone: str(pick(supplierRaw, 'phone', 'telefono', 'tel'), 40),
      address: str(pick(supplierRaw, 'address', 'direccion')),
      city: str(pick(supplierRaw, 'city', 'ciudad'), 80),
    },
    invoice: {
      number: str(
        pick(invoiceRaw, 'number', 'numero', 'invoicenumber', 'consecutivo'),
        60,
      ),
      issueDate: parseDate(
        pick(invoiceRaw, 'issuedate', 'fecha', 'fechaemision', 'date'),
      ),
      dueDate: parseDate(
        pick(invoiceRaw, 'duedate', 'fechavencimiento', 'vencimiento'),
      ),
      paymentTerms,
    },
    lines: parseLines(linesRaw),
    totals: {
      subtotal: parseCop(pick(totalsRaw, 'subtotal', 'base', 'neto')),
      iva: parseCop(pick(totalsRaw, 'iva', 'tax', 'impuesto', 'impuestos')),
      retentions: parseCop(
        pick(totalsRaw, 'retentions', 'retenciones', 'retencion'),
      ),
      total: parseCop(pick(totalsRaw, 'total', 'totalapagar', 'granTotal')),
    },
  };
}

function parseLines(raw: unknown): ExtractedLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: ExtractedLine[] = [];
  for (const item of raw) {
    const line = asObject(item);
    const description = str(
      pick(line, 'description', 'descripcion', 'name', 'nombre', 'producto', 'concepto'),
    );
    // Una línea sin descripción no es una línea: es ruido de la tabla.
    if (!description) continue;

    const ivaRaw = parseAmount(
      pick(line, 'ivarate', 'iva', 'tax', 'impuesto', 'tarifaiva'),
    );
    const ivaRate =
      ivaRaw !== undefined && IVA_RATES.includes(Math.round(ivaRaw))
        ? Math.round(ivaRaw)
        : undefined;

    lines.push({
      description,
      qty: parseQty(pick(line, 'qty', 'cantidad', 'cant', 'quantity')),
      unit: str(pick(line, 'unit', 'unidad', 'und', 'uom'), 20),
      unitCost: parseCop(
        pick(line, 'unitcost', 'valorunitario', 'vrunitario', 'preciounitario', 'precio', 'unitprice'),
      ),
      discount: parseCop(pick(line, 'discount', 'descuento')),
      ivaRate,
      lineTotal: parseCop(
        pick(line, 'linetotal', 'total', 'valortotal', 'importe', 'subtotal'),
      ),
      code: str(pick(line, 'code', 'codigo', 'referencia', 'ref'), 60),
      barcode: str(pick(line, 'barcode', 'codigobarras', 'ean'), 60),
    });
  }
  return lines;
}
