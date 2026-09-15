/**
 * Lectura EXACTA de la factura electrónica de la DIAN (UBL 2.1).
 *
 * La factura electrónica colombiana llega por correo como un ZIP con un PDF y
 * un XML. El PDF es para mirar; el XML trae los datos tal cual se reportaron a
 * la DIAN: NIT, número, renglones, IVA, retenciones y totales, sin nada que
 * adivinar. Leerlo es más preciso que cualquier OCR, instantáneo y no gasta la
 * lectura con IA.
 *
 * Soporta los dos XML que circulan:
 *  - el `AttachedDocument` (el contenedor que llega al comprador), que trae la
 *    `Invoice` firmada dentro de `cac:Attachment/cac:ExternalReference/
 *    cbc:Description`, normalmente como CDATA;
 *  - la `Invoice` suelta.
 *
 * No depende de los prefijos (`cac:`, `cbc:`), que cada proveedor tecnológico
 * declara a su manera. Los importes del XML se toman como números exactos: NO
 * pasan por `parseAmount`, que está hecho para texto impreso y leería
 * "4.000000" como cuatro millones.
 *
 * Dominio puro: sin Nest, sin Mongoose.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ExtractedInvoice, ExtractedLine } from './invoice-extraction';

/** Error con un mensaje que se le puede mostrar a la persona tal cual. */
export class UblInvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UblInvoiceError';
  }
}

/** Etiquetas que pueden repetirse y que siempre se leen como arreglo. */
const ARRAY_TAGS = new Set([
  'InvoiceLine',
  'TaxTotal',
  'TaxSubtotal',
  'WithholdingTaxTotal',
  'PaymentMeans',
  'AllowanceCharge',
  'PartyTaxScheme',
  'PartyLegalEntity',
  'AddressLine',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  // Todo como texto: los números se convierten aquí, con reglas propias.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name: string) => ARRAY_TAGS.has(name),
});

/** Códigos de impuesto de la DIAN (`cac:TaxScheme/cbc:ID`). */
const TAX_IVA = '01';

/** `schemeName` del NIT/documento del emisor. */
const DOC_TYPES: Record<string, 'NIT' | 'CC' | 'CE'> = {
  '31': 'NIT',
  '13': 'CC',
  '22': 'CE',
};

type Node = Record<string, unknown>;

function asArray<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function node(value: unknown): Node {
  const one = first(value);
  return one && typeof one === 'object' ? (one as Node) : {};
}

/** Texto de un elemento, tenga o no atributos. */
function text(value: unknown): string | undefined {
  const one = first(value);
  if (one === undefined || one === null) return undefined;
  if (typeof one === 'string') return one.trim() || undefined;
  if (typeof one === 'number' || typeof one === 'boolean') return String(one);
  if (typeof one === 'object' && '#text' in (one as Node)) {
    return text((one as Node)['#text']);
  }
  return undefined;
}

function attr(value: unknown, name: string): string | undefined {
  const one = first(value);
  if (!one || typeof one !== 'object') return undefined;
  const raw = (one as Node)[`@_${name}`];
  return raw === undefined ? undefined : String(raw).trim();
}

/** Número exacto del XML ("11619.05", "4.000000"). */
function num(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Number(raw.replace(/\s/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Pesos enteros, como el resto de la contabilidad. */
function cop(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}

interface TaxLine {
  scheme?: string;
  percent?: number;
  amount: number;
}

function taxLines(taxTotals: unknown): TaxLine[] {
  const lines: TaxLine[] = [];
  for (const total of asArray<Node>(taxTotals)) {
    for (const sub of asArray<Node>(total.TaxSubtotal)) {
      const category = node(sub.TaxCategory);
      lines.push({
        scheme: text(node(category.TaxScheme).ID),
        percent: num(category.Percent),
        amount: num(sub.TaxAmount) ?? 0,
      });
    }
  }
  return lines;
}

function ivaRateOf(taxes: TaxLine[]): number | undefined {
  const iva = taxes.find((t) => t.scheme === TAX_IVA);
  if (!iva || iva.percent === undefined) return undefined;
  const rate = Math.round(iva.percent);
  return [0, 5, 19].includes(rate) ? rate : undefined;
}

/** Busca la `Invoice` embebida en un `AttachedDocument`. */
function embeddedInvoiceXml(attached: Node): string | undefined {
  const direct = text(node(node(attached.Attachment).ExternalReference).Description);
  if (direct && /<([\w-]+:)?Invoice[\s>]/.test(direct)) return direct;
  // Algunos proveedores la ponen en otro lugar del contenedor: se recorre.
  const stack: unknown[] = [attached];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (/<([\w-]+:)?Invoice[\s>]/.test(current)) return current;
    } else if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current && typeof current === 'object') {
      stack.push(...Object.values(current as Node));
    }
  }
  return undefined;
}

function parseXml(xml: string): Node {
  try {
    return parser.parse(xml) as Node;
  } catch {
    throw new UblInvoiceError(
      'El XML está dañado y no se puede leer. Descárgalo otra vez del correo.',
    );
  }
}

/** La `Invoice` del XML, venga suelta o dentro del `AttachedDocument`. */
function findInvoice(xml: string): Node {
  const doc = parseXml(xml);
  if (doc.CreditNote || doc.DebitNote) {
    throw new UblInvoiceError(
      'Este XML es una nota crédito o débito, no una factura de compra.',
    );
  }
  if (doc.Invoice) return node(doc.Invoice);
  if (doc.AttachedDocument) {
    const inner = embeddedInvoiceXml(node(doc.AttachedDocument));
    if (!inner) {
      throw new UblInvoiceError(
        'El XML es un contenedor de la DIAN pero no trae la factura adentro.',
      );
    }
    return findInvoice(inner);
  }
  throw new UblInvoiceError(
    'El XML no es una factura electrónica de la DIAN.',
  );
}

function parseLine(raw: Node): ExtractedLine | null {
  const item = node(raw.Item);
  const description = asArray(item.Description)
    .map((d) => text(d))
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!description) return null;

  const qty = num(raw.InvoicedQuantity);
  const base = num(raw.LineExtensionAmount);
  const taxes = taxLines(raw.TaxTotal);
  const taxAmount = taxes.reduce((sum, t) => sum + t.amount, 0);
  const price = node(raw.Price);
  const priceAmount = num(price.PriceAmount);
  const baseQuantity = num(price.BaseQuantity) || 1;
  const unitCost =
    priceAmount !== undefined
      ? priceAmount / baseQuantity
      : base !== undefined && qty
        ? base / qty
        : undefined;
  const discount = asArray<Node>(raw.AllowanceCharge)
    .filter((a) => text(a.ChargeIndicator) === 'false')
    .reduce((sum, a) => sum + (num(a.Amount) ?? 0), 0);

  const standard = node(item.StandardItemIdentification);
  const sellers = text(node(item.SellersItemIdentification).ID);
  const standardId = text(standard.ID);
  // schemeID 010 = GTIN (código de barras); 999 = estándar del contribuyente.
  const isBarcode = attr(standard.ID, 'schemeID') === '010';

  return {
    description,
    qty,
    unit: attr(raw.InvoicedQuantity, 'unitCode'),
    unitCost: cop(unitCost),
    discount: discount > 0 ? cop(discount) : undefined,
    ivaRate: ivaRateOf(taxes),
    // Como en la factura impresa: el total del renglón con sus impuestos.
    lineTotal: base !== undefined ? cop(base + taxAmount) : undefined,
    code: sellers ?? (isBarcode ? undefined : standardId),
    barcode: isBarcode ? standardId : undefined,
  };
}

/**
 * Convierte el XML de la factura electrónica en el borrador de siempre.
 * Lanza `UblInvoiceError` con un mensaje para la persona si no se puede.
 */
export function parseUblInvoice(xml: string): ExtractedInvoice {
  const invoice = findInvoice(xml);

  const party = node(node(invoice.AccountingSupplierParty).Party);
  const taxScheme = node(party.PartyTaxScheme);
  const legal = node(party.PartyLegalEntity);
  const companyId = taxScheme.CompanyID ?? legal.CompanyID;
  const docNumber = text(companyId)?.replace(/\D/g, '') || undefined;
  const address = node(node(party.PhysicalLocation).Address);
  const registrationAddress = node(taxScheme.RegistrationAddress);

  const paymentMeans = node(invoice.PaymentMeans);
  const paymentCode = text(paymentMeans.ID);

  const lines = asArray<Node>(invoice.InvoiceLine)
    .map(parseLine)
    .filter((line): line is ExtractedLine => line !== null);

  const monetary = node(invoice.LegalMonetaryTotal);
  const invoiceTaxes = taxLines(invoice.TaxTotal);
  const iva = invoiceTaxes
    .filter((t) => t.scheme === TAX_IVA)
    .reduce((sum, t) => sum + t.amount, 0);
  const retentions = asArray<Node>(invoice.WithholdingTaxTotal).reduce(
    (sum, w) => sum + (num(w.TaxAmount) ?? 0),
    0,
  );

  const number = text(invoice.ID);
  const total = num(monetary.PayableAmount);
  if (!number && lines.length === 0 && total === undefined) {
    throw new UblInvoiceError(
      'El XML no trae los datos de una factura (número, renglones ni total).',
    );
  }

  return {
    supplier: {
      name:
        text(taxScheme.RegistrationName) ??
        text(legal.RegistrationName) ??
        text(node(party.PartyName).Name),
      docNumber,
      docType: DOC_TYPES[attr(companyId, 'schemeName') ?? ''] ?? (docNumber ? 'NIT' : undefined),
      phone: text(node(party.Contact).Telephone),
      address:
        text(node(address.AddressLine).Line) ??
        text(node(registrationAddress.AddressLine).Line),
      city: text(address.CityName) ?? text(registrationAddress.CityName),
    },
    invoice: {
      number,
      issueDate: text(invoice.IssueDate),
      dueDate: text(invoice.DueDate) ?? text(paymentMeans.PaymentDueDate),
      // DIAN: 1 = contado, 2 = crédito.
      paymentTerms:
        paymentCode === '1' ? 'contado' : paymentCode === '2' ? 'credito' : undefined,
    },
    lines,
    totals: {
      subtotal: cop(num(monetary.LineExtensionAmount)),
      iva: invoiceTaxes.length > 0 ? cop(iva) : undefined,
      retentions: cop(retentions),
      total: cop(total),
    },
  };
}
