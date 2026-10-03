import {
  APIDIAN_DISCREPANCY,
  APIDIAN_ID_TYPE_BY_DIAN_CODE,
  APIDIAN_ITEM_ID_ESTANDAR,
  APIDIAN_LIABILITY,
  APIDIAN_ORGANIZATION,
  APIDIAN_PAYMENT_FORM,
  APIDIAN_PAYMENT_METHOD_BY_SALE,
  APIDIAN_PAYMENT_METHOD_UNDEFINED,
  APIDIAN_REGIME,
  APIDIAN_TAX,
  APIDIAN_TYPE_DISCOUNT_PROPINA,
  APIDIAN_TYPE_DOCUMENT,
  APIDIAN_UNIT_MEASURE_UNIDAD,
  CONSUMIDOR_FINAL_ID,
  findMunicipalityId,
} from './apidian-catalogs';
import type {
  EinvoiceCustomer,
  EinvoiceDocument,
  EinvoiceLine,
} from './einvoice-document';
import type { SendOutcome } from './send-outcome';

/**
 * Traductor entre el documento de BookiPos y el JSON de APIDIAN.
 *
 * Dos reglas lo gobiernan:
 *
 * 1. **Los totales tienen que cuadrar al centavo.** La DIAN valida que la base
 *    de cada línea sea cantidad × precio − descuentos, y que los totales sean
 *    la suma de las líneas. Por eso el precio unitario se calcula una vez, se
 *    redondea, y el descuento se deduce de él: así la cuenta cierra exacta en
 *    vez de "casi".
 *
 * 2. **APIDIAN responde `success: true` aunque la DIAN rechace.** El veredicto
 *    real está en `ResponseDian…IsValid`. `interpretApidianResponse` es el
 *    único lugar que lo lee.
 *
 * Dominio puro: sin Nest ni Mongoose, para probarlo sin red.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Importe como lo espera APIDIAN: texto con dos decimales y punto. */
const amt = (n: number) => round2(n).toFixed(2);

/** Dígito de verificación de un NIT (algoritmo de la DIAN, módulo 11). */
export function nitCheckDigit(nit: string): string {
  const digits = nit.replace(/\D/g, '');
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[digits.length - 1 - i]) * (weights[i] ?? 0);
  }
  const r = sum % 11;
  return String(r > 1 ? 11 - r : r);
}

/**
 * Separa "900123456-7" en número y DV. Si no viene DV y es NIT, lo calcula.
 */
export function splitNit(raw: string): { number: string; dv: string } {
  const [num = '', dv] = raw.split('-').map((s) => s.replace(/\D/g, ''));
  return { number: num, dv: dv || nitCheckDigit(num) };
}

function isConsumidorFinal(c: EinvoiceCustomer): boolean {
  const n = (c.docNumber ?? '').replace(/\D/g, '');
  return !n || n === CONSUMIDOR_FINAL_ID;
}

/**
 * Lo que le falta al adquiriente para poder facturarle con sus datos.
 *
 * APIDIAN exige dirección y teléfono a todo cliente identificado (no al
 * consumidor final). Se valida ANTES de quemar el consecutivo: sin esto la
 * factura saldría rechazada con un número ya gastado.
 */
export function missingCustomerData(c: EinvoiceCustomer): string[] {
  if (isConsumidorFinal(c)) return [];
  const faltan: string[] = [];
  if (!c.name?.trim()) faltan.push('nombre');
  if (!c.address?.trim()) faltan.push('dirección');
  if (!c.phone?.trim()) faltan.push('teléfono');
  return faltan;
}

function mapCustomer(c: EinvoiceCustomer, fallbackMunicipality?: number) {
  if (isConsumidorFinal(c)) {
    return {
      identification_number: CONSUMIDOR_FINAL_ID,
      name: 'CONSUMIDOR FINAL',
      merchant_registration: '0000000-00',
    };
  }
  const docType = c.docType ?? '13';
  const isNit = docType === '31';
  const { number, dv } = isNit
    ? splitNit(c.docNumber ?? '')
    : { number: (c.docNumber ?? '').replace(/[^0-9A-Za-z]/g, ''), dv: '' };
  return {
    identification_number: number,
    ...(isNit ? { dv } : {}),
    name: (c.name ?? '').trim(),
    phone: (c.phone ?? '').trim(),
    address: (c.address ?? '').trim(),
    ...(c.email ? { email: c.email.trim() } : {}),
    merchant_registration: '0000000-00',
    type_document_identification_id: APIDIAN_ID_TYPE_BY_DIAN_CODE[docType] ?? 3,
    type_organization_id: isNit
      ? APIDIAN_ORGANIZATION.JURIDICA
      : APIDIAN_ORGANIZATION.NATURAL,
    type_regime_id: APIDIAN_REGIME.NO_RESPONSABLE_IVA,
    type_liability_id: APIDIAN_LIABILITY.NO_APLICA,
    ...(fallbackMunicipality ? { municipality_id: fallbackMunicipality } : {}),
  };
}

/** Línea del JSON con base, descuento e impuesto que cuadran exactos. */
function mapLine(l: EinvoiceLine) {
  const qty = l.qty > 0 ? l.qty : 1;
  const rate = l.taxKind === 'none' ? 0 : l.taxRate;
  // Precio unitario sin impuesto, a partir del bruto con impuesto.
  const unitNoTax = round2(l.grossTotal / (1 + rate / 100) / qty);
  const grossBase = round2(unitNoTax * qty);
  // El descuento es lo que separa el bruto sin impuesto de la base final.
  // Si el redondeo lo dejara negativo (base apenas por encima), se absorbe.
  const discount = Math.max(0, round2(grossBase - l.base));
  const base = round2(grossBase - discount);
  // El impuesto se recalcula sobre la base redondeada: la DIAN valida
  // impuesto = base × tarifa, y la diferencia con el del POS es de centavos.
  const tax = l.taxKind === 'none' ? 0 : round2((base * rate) / 100);

  const line: Record<string, unknown> = {
    unit_measure_id: APIDIAN_UNIT_MEASURE_UNIDAD,
    invoiced_quantity: String(qty),
    line_extension_amount: amt(base),
    free_of_charge_indicator: false,
    description: l.description,
    code: l.code || 'SIN-CODIGO',
    type_item_identification_id: APIDIAN_ITEM_ID_ESTANDAR,
    price_amount: amt(unitNoTax),
    base_quantity: String(qty),
  };
  if (discount > 0) {
    line.allowance_charges = [
      {
        charge_indicator: false,
        allowance_charge_reason: 'DESCUENTO',
        amount: amt(discount),
        base_amount: amt(grossBase),
      },
    ];
  }
  if (l.taxKind !== 'none') {
    line.tax_totals = [
      {
        tax_id: l.taxKind === 'inc' ? APIDIAN_TAX.INC : APIDIAN_TAX.IVA,
        tax_amount: amt(tax),
        taxable_amount: amt(base),
        percent: amt(rate),
      },
    ];
  }
  return { line, base, tax };
}

/** Totales por tributo y tarifa, como los pide la cabecera. */
function taxTotals(
  lines: EinvoiceLine[],
  mapped: { base: number; tax: number }[],
) {
  const groups = new Map<string, { taxId: number; rate: number; tax: number; base: number }>();
  lines.forEach((l, i) => {
    if (l.taxKind === 'none') return;
    const taxId = l.taxKind === 'inc' ? APIDIAN_TAX.INC : APIDIAN_TAX.IVA;
    const key = `${taxId}:${l.taxRate}`;
    const g = groups.get(key) ?? { taxId, rate: l.taxRate, tax: 0, base: 0 };
    g.tax += mapped[i]?.tax ?? 0;
    g.base += mapped[i]?.base ?? 0;
    groups.set(key, g);
  });
  return [...groups.values()].map((g) => ({
    tax_id: g.taxId,
    tax_amount: amt(g.tax),
    percent: amt(g.rate),
    taxable_amount: amt(g.base),
  }));
}

/** Cuerpo común de factura y nota crédito. */
function buildBody(doc: EinvoiceDocument) {
  const municipality = findMunicipalityId(
    doc.issuer.departamento,
    doc.issuer.ciudad,
  );
  const mapped = doc.lines.map(mapLine);
  const lineExtension = round2(mapped.reduce((s, m) => s + m.base, 0));
  const taxableSum = round2(
    mapped.reduce((s, m, i) => s + (doc.lines[i]?.taxKind === 'none' ? 0 : m.base), 0),
  );
  const taxSum = round2(mapped.reduce((s, m) => s + m.tax, 0));
  const tip = round2(doc.tip ?? 0);
  const taxInclusive = round2(lineExtension + taxSum);

  const body: Record<string, unknown> = {
    number: doc.number,
    prefix: doc.prefix,
    date: doc.issueDate,
    time: doc.issueTime,
    sendmail: Boolean(doc.customer.email) && !isConsumidorFinal(doc.customer),
    sendmailtome: false,
    customer: mapCustomer(doc.customer, municipality),
    legal_monetary_totals: {
      line_extension_amount: amt(lineExtension),
      tax_exclusive_amount: amt(taxableSum),
      tax_inclusive_amount: amt(taxInclusive),
      allowance_total_amount: amt(0),
      charge_total_amount: amt(tip),
      payable_amount: amt(taxInclusive + tip),
    },
    tax_totals: taxTotals(doc.lines, mapped),
  };
  if (doc.notes) body.notes = doc.notes;
  if (doc.issuer.name) body.establishment_name = doc.issuer.name;
  if (doc.issuer.address) body.establishment_address = doc.issuer.address;
  const phone = (doc.issuer.phone ?? '').replace(/\D/g, '');
  if (phone.length >= 7 && phone.length <= 10) body.establishment_phone = phone;
  if (municipality) body.establishment_municipality = municipality;
  if (doc.issuer.email) body.establishment_email = doc.issuer.email;
  if (tip > 0) {
    // La propina es voluntaria y no hace parte de la base (Ley 1935 de 2018),
    // pero debe quedar en la factura: va como cargo, sin impuesto.
    body.allowance_charges = [
      {
        type_discount_id: APIDIAN_TYPE_DISCOUNT_PROPINA,
        charge_indicator: true,
        allowance_charge_reason: 'PROPINA VOLUNTARIA',
        amount: amt(tip),
        base_amount: amt(taxInclusive),
      },
    ];
  }
  return { body, lines: mapped.map((m) => m.line) };
}

/** Factura electrónica de venta (POST /ubl2.1/invoice). */
export function toApidianInvoice(doc: EinvoiceDocument): Record<string, unknown> {
  const { body, lines } = buildBody(doc);
  const method = doc.paymentMethod ?? 'cash';
  const onCredit = method === 'credit';
  return {
    ...body,
    type_document_id: APIDIAN_TYPE_DOCUMENT.INVOICE,
    ...(doc.resolutionNumber ? { resolution_number: doc.resolutionNumber } : {}),
    payment_form: {
      payment_form_id: onCredit
        ? APIDIAN_PAYMENT_FORM.CREDITO
        : APIDIAN_PAYMENT_FORM.CONTADO,
      payment_method_id:
        APIDIAN_PAYMENT_METHOD_BY_SALE[method] ?? APIDIAN_PAYMENT_METHOD_UNDEFINED,
      payment_due_date: onCredit ? addDays(doc.issueDate, 30) : doc.issueDate,
      duration_measure: onCredit ? '30' : '0',
    },
    invoice_lines: lines,
  };
}

/** Nota crédito que anula una factura (POST /ubl2.1/credit-note). */
export function toApidianCreditNote(
  doc: EinvoiceDocument,
): Record<string, unknown> {
  if (!doc.reference) {
    throw new Error('Una nota crédito necesita la factura que corrige.');
  }
  const { body, lines } = buildBody(doc);
  return {
    ...body,
    type_document_id: APIDIAN_TYPE_DOCUMENT.CREDIT_NOTE,
    billing_reference: {
      number: doc.reference.fullNumber,
      uuid: doc.reference.cufe,
      issue_date: doc.reference.issueDate,
    },
    discrepancyresponsecode: APIDIAN_DISCREPANCY.ANULACION,
    discrepancyresponsedescription: doc.reason ?? 'Anulación de factura electrónica',
    credit_note_lines: lines,
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Respuestas ─────────────────────────────────────────────────────────────────

type Json = Record<string, any>;

/** Resultado de la DIAN dentro de la respuesta de APIDIAN, sea envío o consulta. */
function dianResult(body: Json): Json | undefined {
  const b = body?.ResponseDian?.Envelope?.Body;
  return (
    b?.SendBillSyncResponse?.SendBillSyncResult ??
    b?.GetStatusResponse?.GetStatusResult ??
    b?.GetStatusZipResponse?.GetStatusZipResult?.DianResponse
  );
}

/** Los mensajes de error de la DIAN llegan como texto o como lista. */
function dianErrors(result: Json): string[] {
  const raw = result?.ErrorMessage?.string ?? result?.ErrorMessage;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

/** Errores de validación de Laravel (HTTP 422): `{ errors: { campo: [msg] } }`. */
function validationErrors(body: Json): string[] {
  const errs = body?.errors;
  if (!errs || typeof errs !== 'object') return [];
  return Object.entries(errs).flatMap(([field, msgs]) =>
    (Array.isArray(msgs) ? msgs : [msgs]).map((m) => `${field}: ${String(m)}`),
  );
}

const UNAVAILABLE = /no est[aá] disponible|no se encuentra disponible|reintente/i;
const ALREADY_SENT = /enviado anteriormente/i;
/** Regla 90 de la DIAN: "Documento procesado anteriormente". */
const RULE_90 = /Regla:\s*90\b/i;

/**
 * Interpreta lo que respondió APIDIAN al enviar o consultar un documento.
 *
 * `httpStatus` 0 significa que no hubo respuesta (red caída o timeout).
 */
export function interpretApidianResponse(
  httpStatus: number,
  body: unknown,
): SendOutcome {
  const json = (body ?? {}) as Json;
  const base = {
    cufe: typeof json.cufe === 'string' && json.cufe ? json.cufe : undefined,
    qrUrl: typeof json.QRStr === 'string' && json.QRStr ? json.QRStr : undefined,
    certificateDaysLeft:
      json.certificate_days_left != null && !Number.isNaN(Number(json.certificate_days_left))
        ? Number(json.certificate_days_left)
        : undefined,
  };

  if (httpStatus === 0 || httpStatus >= 500) {
    return {
      ...base,
      status: 'pending',
      message: 'El servicio de facturación no respondió. Se reintentará solo.',
      errors: [],
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      ...base,
      status: 'failed',
      message: 'La conexión con el facturador fue rechazada: revisa la configuración de facturación electrónica.',
      errors: [String(json.message ?? `HTTP ${httpStatus}`)],
    };
  }
  if (httpStatus === 422) {
    return {
      ...base,
      status: 'rejected',
      message: 'El documento tiene datos inválidos y no se envió a la DIAN.',
      errors: validationErrors(json),
    };
  }

  const result = dianResult(json);
  if (result) {
    const errors = dianErrors(result);
    const cufe = (result.XmlDocumentKey as string) || base.cufe;
    if (String(result.IsValid) === 'true') {
      return {
        ...base,
        cufe,
        status: 'accepted',
        message: 'Aceptada por la DIAN.',
        // Las notificaciones (no bloquean) también llegan en ErrorMessage.
        errors,
        files: {
          pdf: json.urlinvoicepdf,
          xml: json.urlinvoicexml,
          attached: json.urlinvoiceattached,
        },
      };
    }
    if (errors.some((e) => RULE_90.test(e))) {
      return {
        ...base,
        cufe,
        status: 'duplicate',
        message: 'La DIAN ya había recibido este documento. Se consulta su estado.',
        errors,
      };
    }
    return {
      ...base,
      cufe,
      status: 'rejected',
      message: String(
        result.StatusDescription ?? result.StatusMessage ?? 'Rechazada por la DIAN.',
      ),
      errors,
    };
  }

  const message = String(json.message ?? '');
  if (json.success === false && ALREADY_SENT.test(message)) {
    return {
      ...base,
      status: 'duplicate',
      message: 'Este documento ya se había enviado. Se consulta su estado.',
      errors: [],
    };
  }
  if (json.success === false && UNAVAILABLE.test(message)) {
    return {
      ...base,
      status: 'pending',
      message: 'La DIAN no está disponible en este momento. Se reintentará solo.',
      errors: [],
    };
  }
  if (json.success === false) {
    // Certificado vencido, empresa inactiva, resolución mal configurada…
    return {
      ...base,
      status: 'failed',
      message: message || 'El facturador no pudo procesar el documento.',
      errors: message ? [message] : [],
    };
  }
  // Respondió bien pero sin veredicto de la DIAN: se averigua consultando.
  return {
    ...base,
    status: 'pending',
    message: 'Enviado; falta confirmar el resultado de la DIAN.',
    errors: [],
  };
}

/** Datos del emisor que APIDIAN necesita para crear la empresa. */
export interface ApidianCompanyInput {
  nit: string;
  dv?: string;
  businessName: string;
  tipoPersona?: 'natural' | 'juridica';
  responsabilidadFiscal?:
    | 'responsable_iva'
    | 'no_responsable_iva'
    | 'regimen_simple'
    | 'gran_contribuyente';
  address: string;
  phone: string;
  email: string;
  departamento?: string;
  ciudad?: string;
}

/**
 * Cuerpo de POST /ubl2.1/config/{nit}/{dv}. Lanza si falta algo que APIDIAN
 * exige, con el nombre del dato para que el usuario lo complete en la sede.
 */
export function toApidianCompany(input: ApidianCompanyInput): {
  nit: string;
  dv: string;
  body: Record<string, unknown>;
} {
  const { number: nit, dv } = splitNit(
    input.dv ? `${input.nit}-${input.dv}` : input.nit,
  );
  const municipality = findMunicipalityId(input.departamento, input.ciudad);
  const phone = input.phone.replace(/\D/g, '');
  const faltan: string[] = [];
  if (!nit) faltan.push('NIT');
  if (!input.businessName?.trim()) faltan.push('razón social');
  if (!input.address?.trim()) faltan.push('dirección');
  if (phone.length < 7 || phone.length > 10) faltan.push('teléfono (7 a 10 dígitos)');
  if (!input.email?.trim()) faltan.push('correo de facturación');
  if (!municipality) faltan.push('departamento y ciudad reconocibles');
  if (faltan.length) {
    throw new Error(`Faltan datos fiscales de la sede: ${faltan.join(', ')}.`);
  }

  const juridica = input.tipoPersona !== 'natural';
  const resp = input.responsabilidadFiscal ?? 'responsable_iva';
  const liability =
    resp === 'gran_contribuyente'
      ? APIDIAN_LIABILITY.GRAN_CONTRIBUYENTE
      : resp === 'regimen_simple'
        ? APIDIAN_LIABILITY.REGIMEN_SIMPLE
        : APIDIAN_LIABILITY.NO_APLICA;

  return {
    nit,
    dv,
    body: {
      type_document_identification_id: APIDIAN_ID_TYPE_BY_DIAN_CODE['31'],
      type_organization_id: juridica
        ? APIDIAN_ORGANIZATION.JURIDICA
        : APIDIAN_ORGANIZATION.NATURAL,
      type_regime_id:
        resp === 'no_responsable_iva'
          ? APIDIAN_REGIME.NO_RESPONSABLE_IVA
          : APIDIAN_REGIME.RESPONSABLE_IVA,
      type_liability_id: liability,
      business_name: input.businessName.trim(),
      merchant_registration: '0000000-00',
      municipality_id: municipality,
      address: input.address.trim(),
      phone,
      email: input.email.trim(),
    },
  };
}
