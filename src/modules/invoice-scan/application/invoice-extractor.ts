import { ExtractedInvoice } from '../domain/invoice-extraction';

/** Token de inyección: qué implementación se usa lo decide el módulo. */
export const INVOICE_EXTRACTOR = Symbol('INVOICE_EXTRACTOR');

export interface ExtractorResult {
  /** Respuesta cruda del proveedor, tal cual. Se guarda para poder depurar. */
  raw: unknown;
  parsed: ExtractedInvoice;
  model: string;
  ms: number;
}

/**
 * Lee una factura a partir de su imagen.
 *
 * Hay dos implementaciones (Qwen y GLM) porque cuál lee mejor una factura
 * colombiana arrugada no se decide leyendo benchmarks: se decide midiendo con
 * facturas reales. La interfaz permite cambiar de una a otra con una variable
 * de entorno, sin tocar nada más.
 */
export interface InvoiceExtractor {
  /** Nombre legible del modelo, para el historial. */
  readonly model: string;
  /** ¿Está configurado? Sin llaves, el módulo responde 503 con mensaje claro. */
  readonly enabled: boolean;

  /** Lee la factura de una imagen (foto o página rasterizada). */
  extract(image: Buffer, mimetype: string): Promise<ExtractorResult>;

  /**
   * Lee la factura de su TEXTO, cuando el PDF ya lo trae.
   *
   * Las facturas electrónicas llegan por correo en PDF con capa de texto: los
   * caracteres ya están ahí, exactos. Pasarlas por OCR sería reconocer con un
   * modelo de visión —y con su margen de error en los precios— algo que se
   * puede leer sin equivocarse. Este camino usa un modelo de texto: más
   * preciso, mucho más barato y bastante más rápido.
   */
  extractText(text: string): Promise<ExtractorResult>;
}

/**
 * Instrucción que se le da al modelo. Es deliberadamente estricta en dos cosas:
 * **no inventar** y **no convertir**.
 *
 * Lo primero, porque un número inventado entra a la contabilidad sin que nadie
 * lo note; un campo vacío, en cambio, salta a la vista en la pantalla de
 * revisión. Lo segundo, porque las conversiones (IVA incluido, descuentos
 * prorrateados, cajas a unidades) las hace nuestro código con reglas fijas y
 * auditables, no el modelo con criterio propio.
 */
export const EXTRACTION_PROMPT = [
  'Eres un asistente que lee facturas de compra colombianas y devuelve JSON.',
  'Devuelve ÚNICAMENTE un objeto JSON válido, sin explicaciones ni markdown.',
  '',
  'Reglas estrictas:',
  '- Copia los valores TAL CUAL aparecen impresos. No calcules, no conviertas, no completes.',
  '- Si un dato no aparece o no se lee con certeza, omite la clave. NUNCA inventes un valor.',
  '- Los importes van como TEXTO, copiados tal cual aparecen impresos ("4.450", "7.425"). No los conviertas a número ni les quites los puntos.',
  '- Las fechas en formato AAAA-MM-DD.',
  '- El NIT sin puntos ni dígito de verificación.',
  '- Una línea por renglón de producto o servicio de la factura.',
  '- No incluyas como líneas los renglones de subtotal, IVA, descuento global ni total: esos van en "totals".',
  '- "ivaRate" solo puede ser 0, 5 o 19.',
  '',
  'Estructura exacta:',
  JSON.stringify(
    {
      supplier: {
        name: 'string',
        docNumber: 'string',
        docType: 'NIT|CC|CE',
        phone: 'string',
        address: 'string',
        city: 'string',
      },
      invoice: {
        number: 'string',
        issueDate: 'AAAA-MM-DD',
        dueDate: 'AAAA-MM-DD',
        paymentTerms: 'contado|credito',
      },
      lines: [
        {
          description: 'string',
          code: 'string',
          barcode: 'string',
          qty: 'string',
          unit: 'string',
          unitCost: 'string tal cual impreso',
          discount: 'string',
          ivaRate: 0,
          lineTotal: 'string tal cual impreso',
        },
      ],
      totals: {
        subtotal: 'string',
        iva: 'string',
        retentions: 'string',
        total: 'string tal cual impreso',
      },
    },
    null,
    2,
  ),
].join('\n');

/** Esquema plano para los modelos que aceptan `result_schema` (Qwen). */
export const EXTRACTION_RESULT_SCHEMA: Record<string, unknown> = {
  supplier: 'Datos del proveedor que emite: name, docNumber (NIT sin dígito de verificación), docType, phone, address, city',
  invoice: 'Datos del documento: number, issueDate (AAAA-MM-DD), dueDate, paymentTerms (contado|credito)',
  lines:
    'Lista de renglones de la factura. Cada uno: description, code, barcode, qty, unit, unitCost, discount, ivaRate (0/5/19), lineTotal. Excluye subtotal, IVA y total.',
  totals: 'Totales del pie: subtotal, iva, retentions, total',
};

/** La imagen como data URL, que es como la aceptan las dos APIs. */
/**
 * Traduce el rechazo del proveedor de lectura a algo accionable.
 *
 * Existe porque el mensaje genérico —"Inténtalo de nuevo en un momento"— costó
 * dos días de diagnóstico: un id de modelo inexistente, una cuenta sin acceso
 * contratado y una cuenta sin saldo producían EXACTAMENTE el mismo texto, y
 * ninguno de los tres se arregla reintentando. El status real solo estaba en el
 * log del servidor, que quien sube la factura no ve.
 *
 * Los mensajes hablan de "el servicio de lectura" y no del proveedor concreto:
 * cuál se usa es una variable de entorno, y el tendero no tiene por qué saber
 * si detrás hay Alibaba o Z.ai. Lo que sí dice es QUÉ hay que hacer y quién.
 */
export function providerErrorMessage(status: number, body: string): string {
  const text = body.toLowerCase();

  // Sin saldo / sin plan contratado. Le pasa al dueño de la cuenta, no a quien
  // sube la factura, así que el mensaje tiene que delatar de quién es el turno.
  if (
    /insufficient balance|no resource package|recharge|"1113"/.test(text) ||
    /unpurchased|not eligible/.test(text)
  ) {
    return (
      'La lectura de facturas está sin cupo: la cuenta del servicio de lectura ' +
      'no tiene saldo o no tiene activado el acceso. Avisa al administrador; ' +
      'reintentar no lo va a resolver.'
    );
  }

  // Id de modelo que no existe: error de configuración, no del proveedor.
  if (/model not exist|invalidparameter.*model|unknown model/.test(text)) {
    return (
      'La lectura de facturas está mal configurada: el modelo indicado no ' +
      'existe. Revisa la variable del modelo en el entorno.'
    );
  }

  // Llave inválida — casi siempre es una llave de otra región.
  if (status === 401 || /invalidapikey|invalid api-key|unauthorized/.test(text)) {
    return (
      'La lectura de facturas no pudo autenticarse: la llave del servicio no es ' +
      'válida o es de otra región. Revísala en el entorno.'
    );
  }

  // Límite de peticiones: esto SÍ se arregla reintentando.
  if (status === 429) {
    return 'El servicio de lectura está saturado. Espera un momento y reintenta.';
  }

  return 'No se pudo leer la factura. Inténtalo de nuevo en un momento.';
}

export function toDataUrl(image: Buffer, mimetype: string): string {
  return `data:${mimetype};base64,${image.toString('base64')}`;
}

/**
 * `fetch` con corte por tiempo.
 *
 * Ninguna integración del repo tiene timeout hoy (Wompi y Resend van a pelo),
 * pero aquí sí hace falta: la petición corre dentro de una función serverless
 * que se cobra por tiempo, con un usuario esperando al otro lado. Una llamada
 * colgada sería factura y spinner infinito a la vez.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Claves que delatan que un objeto es la factura que pedimos. */
const INVOICE_KEYS = [
  'lines',
  'lineas',
  'items',
  'supplier',
  'proveedor',
  'invoice',
  'factura',
  'totals',
  'totales',
];

/**
 * Busca el objeto de la factura dentro de la respuesta del proveedor.
 *
 * Cada API envuelve el resultado a su manera (`output.choices[].message`,
 * `ocr_result.kv_result`, un `text` con el JSON dentro y a veces entre vallas de
 * markdown). En vez de acoplarnos a una forma concreta —que además cambia entre
 * versiones—, se recorre la respuesta y se devuelve el primer objeto que parece
 * la factura. Si no hay ninguno, `null`, y el llamador lo trata como fallo.
 */
export function findInvoicePayload(value: unknown, depth = 0): unknown | null {
  if (depth > 8 || value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const text = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return findInvoicePayload(JSON.parse(text.slice(start, end + 1)), depth + 1);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInvoicePayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).map((k) => k.toLowerCase());
    if (INVOICE_KEYS.some((key) => keys.includes(key))) return record;
    for (const item of Object.values(record)) {
      const found = findInvoicePayload(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
