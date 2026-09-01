import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EXTRACTION_PROMPT,
  ExtractorResult,
  InvoiceExtractor,
  fetchWithTimeout,
  findInvoicePayload,
  toDataUrl,
} from './invoice-extractor';
import { parseExtractedInvoice } from '../domain/invoice-extraction';

const DEFAULT_OCR_URL = 'https://api.z.ai/api/paas/v4/layout_parsing';
const DEFAULT_CHAT_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const DEFAULT_OCR_MODEL = 'glm-ocr';
/** Modelo de texto de la segunda pasada. GLM-5.2 no ve imágenes, pero sí lee. */
const DEFAULT_TEXT_MODEL = 'glm-5.2';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Extractor sobre los modelos de Z.ai, en dos pasadas:
 *
 * 1. **GLM-OCR** convierte la foto en texto/markdown fiel, con su estructura de
 *    tablas. Es lo que mejor hace: lidera OmniDocBench y cuesta una miseria.
 * 2. Un modelo de **texto** (GLM-5.2 por defecto) convierte ese texto en
 *    nuestro JSON.
 *
 * Son dos llamadas y no una porque la API pública de GLM-OCR no expone un
 * parámetro de esquema propio. A cambio, la primera pasada es la parte cara de
 * acertar —los caracteres y la tabla— y la segunda es un problema de texto ya
 * resuelto.
 */
@Injectable()
export class GlmExtractorService implements InvoiceExtractor {
  private readonly logger = new Logger('GlmExtractorService');
  private readonly apiKey?: string;
  private readonly ocrUrl: string;
  private readonly chatUrl: string;
  private readonly ocrModel: string;
  private readonly textModel: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('ZAI_API_KEY');
    this.ocrUrl = this.config.get<string>('ZAI_OCR_URL')?.trim() || DEFAULT_OCR_URL;
    this.chatUrl = this.config.get<string>('ZAI_CHAT_URL')?.trim() || DEFAULT_CHAT_URL;
    this.ocrModel =
      this.config.get<string>('ZAI_OCR_MODEL')?.trim() || DEFAULT_OCR_MODEL;
    this.textModel =
      this.config.get<string>('ZAI_TEXT_MODEL')?.trim() || DEFAULT_TEXT_MODEL;
    this.timeoutMs = Number(
      this.config.get<string>('INVOICE_AI_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS,
    );
  }

  get model(): string {
    return `${this.ocrModel}+${this.textModel}`;
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async extract(image: Buffer, mimetype: string): Promise<ExtractorResult> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'La lectura de facturas no está configurada en este entorno.',
      );
    }
    const started = Date.now();

    const ocr = await this.post(this.ocrUrl, {
      model: this.ocrModel,
      file: toDataUrl(image, mimetype),
    });

    // Si la primera pasada ya trajera algo con forma de factura, nos ahorramos
    // la segunda llamada (y su costo).
    const direct = findInvoicePayload(ocr);
    if (direct) {
      return {
        raw: ocr,
        parsed: parseExtractedInvoice(direct),
        model: this.ocrModel,
        ms: Date.now() - started,
      };
    }

    const documentText = collectText(ocr);
    if (!documentText) {
      this.logger.warn('GLM-OCR no devolvió texto reconocible');
      return {
        raw: ocr,
        parsed: parseExtractedInvoice({}),
        model: this.ocrModel,
        ms: Date.now() - started,
      };
    }

    const chat = await this.chat(documentText);

    return {
      raw: { ocr, chat },
      parsed: parseExtractedInvoice(findInvoicePayload(chat) ?? {}),
      model: this.model,
      ms: Date.now() - started,
    };
  }

  /**
   * Lee la factura de su texto: una sola llamada al modelo de texto, sin OCR.
   * Es el camino de los PDF que ya traen capa de texto.
   */
  async extractText(text: string): Promise<ExtractorResult> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'La lectura de facturas no está configurada en este entorno.',
      );
    }
    const started = Date.now();
    const chat = await this.chat(text);
    return {
      raw: chat,
      parsed: parseExtractedInvoice(findInvoicePayload(chat) ?? {}),
      model: this.textModel,
      ms: Date.now() - started,
    };
  }

  /** Manda un texto al modelo y pide de vuelta el JSON de la factura. */
  private chat(text: string): Promise<unknown> {
    return this.post(this.chatUrl, {
      model: this.textModel,
      temperature: 0,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        {
          role: 'user',
          content: `Texto de la factura:\n\n${text.slice(0, 30_000)}`,
        },
      ],
    });
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        this.timeoutMs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo llamando a ${url}: ${message}`);
      throw new ServiceUnavailableException(
        'No se pudo leer la factura: el servicio de lectura no respondió a tiempo.',
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(
        `Z.ai respondió ${response.status} en ${url}: ${detail.slice(0, 500)}`,
      );
      throw new ServiceUnavailableException(
        'No se pudo leer la factura. Inténtalo de nuevo en un momento.',
      );
    }
    return response.json();
  }
}

/**
 * Junta el texto que venga en la respuesta del OCR, mire donde mire.
 *
 * La forma exacta (`content`, `text`, `markdown`, por página o entera) depende
 * de la versión de la API; recolectar todas las cadenas largas es más robusto
 * que acertar la ruta y romperse en la siguiente versión.
 */
function collectText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.length > 20 ? value : '';
  if (Array.isArray(value)) {
    return value
      .map((item) => collectText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferred = ['content', 'text', 'markdown', 'md', 'result', 'data'];
    const keys = Object.keys(record).sort((a, b) => {
      const ia = preferred.indexOf(a.toLowerCase());
      const ib = preferred.indexOf(b.toLowerCase());
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const key of keys) {
      const text = collectText(record[key], depth + 1);
      if (text) return text;
    }
  }
  return '';
}
