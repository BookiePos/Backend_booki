import { APIDIAN_MUNICIPALITIES } from './apidian-municipalities.data';

/**
 * Catálogos de APIDIAN.
 *
 * APIDIAN no recibe los códigos de la DIAN sino los `id` de sus propias tablas
 * paramétricas (`public/csv/*.csv` de su repositorio). En la mayoría coinciden
 * con el código DIAN, pero no en todas: el tipo de documento de identidad, la
 * responsabilidad fiscal o el municipio tienen ids propios. Por eso el mapeo
 * vive aquí, en un solo lugar, en vez de regado por el mapeador.
 *
 * Dominio puro: sin Nest ni Mongoose.
 */

/** Tributos (`taxes.csv`). */
export const APIDIAN_TAX = {
  IVA: 1,
  INC: 4,
} as const;

/** Tipos de documento electrónico (`type_documents.csv`). */
export const APIDIAN_TYPE_DOCUMENT = {
  INVOICE: 1,
  CREDIT_NOTE: 4,
} as const;

/** Unidad de medida "Unidad" (código DIAN 94) en `unit_measures.csv`. */
export const APIDIAN_UNIT_MEASURE_UNIDAD = 70;

/** "Estándar de adopción del contribuyente" (`type_item_identifications.csv`). */
export const APIDIAN_ITEM_ID_ESTANDAR = 4;

/** Forma de pago (`payment_forms.csv`). El POS vende de contado. */
export const APIDIAN_PAYMENT_FORM = { CONTADO: 1, CREDITO: 2 } as const;

/**
 * Medio de pago por método de cobro del POS (`payment_methods.csv`; hasta el
 * 53 el id coincide con el código DIAN). Fiado y lo que no se reconozca van
 * como "Instrumento no definido".
 */
export const APIDIAN_PAYMENT_METHOD_BY_SALE: Record<string, number> = {
  cash: 10, // Efectivo
  card: 48, // Tarjeta crédito
  transfer: 47, // Transferencia débito bancaria
};
export const APIDIAN_PAYMENT_METHOD_UNDEFINED = 1;

/** Cargo "propina" en `type_discounts.csv` (así lo documenta APIDIAN). */
export const APIDIAN_TYPE_DISCOUNT_PROPINA = 4;

/** Motivo de nota crédito (`credit_note_discrepancy_responses.csv`). */
export const APIDIAN_DISCREPANCY = {
  DEVOLUCION_PARCIAL: 1,
  ANULACION: 2,
  DESCUENTO: 3,
  AJUSTE_PRECIO: 4,
  OTROS: 5,
} as const;

/**
 * Tipo de documento de identidad: código DIAN (13 = CC, 31 = NIT…) → id de
 * `type_document_identifications.csv`.
 */
export const APIDIAN_ID_TYPE_BY_DIAN_CODE: Record<string, number> = {
  '11': 1, // Registro civil
  '12': 2, // Tarjeta de identidad
  '13': 3, // Cédula de ciudadanía
  '21': 4, // Tarjeta de extranjería
  '22': 5, // Cédula de extranjería
  '31': 6, // NIT
  '41': 7, // Pasaporte
  '42': 8, // Documento de identificación extranjero
  '50': 9, // NIT de otro país
  '91': 10, // NUIP
};

/** Tipo de organización (`type_organizations.csv`). */
export const APIDIAN_ORGANIZATION = { JURIDICA: 1, NATURAL: 2 } as const;

/** Régimen (`type_regimes.csv`). */
export const APIDIAN_REGIME = { RESPONSABLE_IVA: 1, NO_RESPONSABLE_IVA: 2 } as const;

/** Responsabilidades fiscales (`type_liabilities.csv`). */
export const APIDIAN_LIABILITY = {
  GRAN_CONTRIBUYENTE: 7, // O-13
  AUTORRETENEDOR: 9, // O-15
  AGENTE_RETENCION_IVA: 14, // O-23
  REGIMEN_SIMPLE: 112, // O-47
  NO_APLICA: 117, // R-99-PN
} as const;

/** Ambiente (`type_environments.csv`). */
export const APIDIAN_ENVIRONMENT = { PRODUCCION: 1, HABILITACION: 2 } as const;

/** NIT genérico del consumidor final. */
export const CONSUMIDOR_FINAL_ID = '222222222222';

/** Normaliza un nombre para compararlo: sin tildes, mayúsculas ni signos. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Alias frecuentes que la tabla escribe distinto. */
const CITY_ALIASES: Record<string, string> = {
  bogota: 'bogota d c',
  'bogota dc': 'bogota d c',
  'santa fe de bogota': 'bogota d c',
  cartagena: 'cartagena de indias',
};

/**
 * Busca el id APIDIAN de un municipio por departamento y ciudad, tal como los
 * escribe el usuario en la sede ("Antioquia" / "Medellín"). También acepta el
 * código DANE de 5 dígitos en `ciudad`.
 *
 * Devuelve `undefined` si no lo encuentra o si el nombre es ambiguo y no hay
 * departamento para desempatar: es preferible pedirle al usuario que lo
 * corrija a mandar la factura con el municipio equivocado.
 */
export function findMunicipalityId(
  departamento: string | undefined,
  ciudad: string | undefined,
): number | undefined {
  if (!ciudad) return undefined;
  const raw = ciudad.trim();
  if (/^\d{5}$/.test(raw)) {
    return APIDIAN_MUNICIPALITIES.find((m) => m[3] === raw)?.[0];
  }
  const c = norm(raw);
  const city = CITY_ALIASES[c] ?? c;
  const candidates = APIDIAN_MUNICIPALITIES.filter((m) => norm(m[2]) === city);
  if (candidates.length === 1) return candidates[0]?.[0];
  if (candidates.length > 1 && departamento) {
    const d = norm(departamento);
    const hit = candidates.filter((m) => norm(m[1]) === d);
    if (hit.length === 1) return hit[0]?.[0];
  }
  return undefined;
}
