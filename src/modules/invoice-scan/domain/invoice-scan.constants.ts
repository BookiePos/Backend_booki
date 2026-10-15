/**
 * Constantes y reglas del escaneo de facturas de compra. Dominio puro: sin
 * Nest, sin Mongoose.
 */

/**
 * Tamaño máximo de la foto que aceptamos, 4 MB.
 *
 * El límite real no es nuestro: el API corre en funciones de Vercel, que
 * rechazan cuerpos de más de 4.5 MB antes de que el handler se ejecute.
 * Cortamos por debajo para poder devolver un error explicable. El navegador
 * comprime en pasadas hasta entrar aquí, así que en la práctica no se ve.
 */
export const INVOICE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** Formatos aceptados y su extensión al guardar. Sin SVG: es un documento con scripts. */
export const INVOICE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export const INVOICE_IMAGE_TYPES_LABEL = 'JPG, PNG, WebP o AVIF';

/** Estados por los que pasa una factura escaneada. */
export const INVOICE_SCAN_STATUSES = [
  /** Imagen subida, todavía sin leer. */
  'uploaded',
  /** El modelo la leyó: hay borrador que revisar. */
  'extracted',
  /** Aplicada al inventario/gastos. Estado final. */
  'applied',
  /** Descartada por el usuario. Estado final. */
  'discarded',
  /** El modelo falló o no se entendió nada. Se puede reintentar. */
  'failed',
] as const;
export type InvoiceScanStatus = (typeof INVOICE_SCAN_STATUSES)[number];

/** Destino de cada renglón de la factura. */
export const LINE_TARGETS = ['inventory', 'expense', 'ignore'] as const;
export type LineTarget = (typeof LINE_TARGETS)[number];

/** Acciones que quedan registradas en el historial de una factura. */
export const SCAN_ACTIONS = [
  'uploaded',
  'extracted',
  'failed',
  'edited',
  'merged',
  'split',
  'applied',
  'discarded',
] as const;
export type ScanAction = (typeof SCAN_ACTIONS)[number];

/**
 * Código de impuesto de core-tax para una tarifa de IVA leída en la factura.
 * Las compras usan códigos con vigencia (`TaxService.compute`), no un número
 * suelto; esta es la traducción entre lo que dice el papel y lo que entiende
 * el motor de impuestos.
 */
export function taxCodeForRate(rate?: number): string {
  if (rate === 19) return 'IVA_19';
  if (rate === 5) return 'IVA_5';
  return 'EXCLUIDO';
}

/**
 * Tolerancia al comparar la suma de las líneas contra el total impreso.
 *
 * No es cero a propósito: las facturas reales redondean por línea y arrastran
 * pesos de diferencia. Por encima de esto se avisa al usuario, pero **nunca se
 * bloquea**: quien tiene el papel delante decide.
 */
export const TOTALS_TOLERANCE_COP = 100;

/**
 * Umbral de similitud para dar por bueno un emparejamiento por nombre.
 *
 * Alto a propósito: emparejar mal es peor que no emparejar. Un falso positivo
 * suma stock al producto equivocado y descuadra dos inventarios a la vez; un
 * falso negativo solo obliga a elegir el producto a mano.
 */
export const NAME_MATCH_THRESHOLD = 0.6;

/**
 * Tope de texto (PDF) o XML que se acepta y se manda al modelo, ~200 KB.
 * Una factura real cabe de sobra; más que eso es abuso o un archivo equivocado
 * y cada token se paga.
 */
export const INVOICE_TEXT_MAX_CHARS = 200_000;

/**
 * Lecturas con IA por factura incluidas en el escaneo que cobró la subida (la
 * primera y un par de reintentos tras un fallo). Desde ahí, cada lectura
 * consume otro escaneo de la cuota mensual del plan.
 */
export const INVOICE_FREE_EXTRACTIONS = 3;

/**
 * Tope del XML de la factura electrónica, 2 MB. No usa IA (se interpreta
 * localmente), pero un XML firmado de la DIAN con su respuesta de validación
 * pasa de 1 MB, así que no le aplica el tope de 200 KB del texto.
 */
export const INVOICE_XML_MAX_CHARS = 2_000_000;
