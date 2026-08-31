import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EXTRACTION_PROMPT,
  EXTRACTION_RESULT_SCHEMA,
  ExtractorResult,
  InvoiceExtractor,
  fetchWithTimeout,
  findInvoicePayload,
  toDataUrl,
} from './invoice-extractor';
import { parseExtractedInvoice } from '../domain/invoice-extraction';

/** Endpoint internacional de Alibaba Model Studio (región Singapur). */
const DEFAULT_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

const DEFAULT_MODEL = 'qwen3.5-ocr';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Extractor sobre los modelos OCR de Qwen (Alibaba Model Studio).
 *
 * Usa el formato nativo de DashScope y no el compatible con OpenAI, porque las
 * dos cosas que nos importan —la tarea `key_information_extraction` con esquema
 * propio y la corrección de rotación (`enable_rotate`), imprescindible en fotos
 * tomadas con el celular— solo existen ahí.
 */
@Injectable()
export class QwenExtractorService implements InvoiceExtractor {
  private readonly logger = new Logger('QwenExtractorService');
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('QWEN_API_KEY');
    this.baseUrl =
      this.config.get<string>('QWEN_BASE_URL')?.trim() || DEFAULT_BASE_URL;
    this.model = this.config.get<string>('QWEN_OCR_MODEL')?.trim() || DEFAULT_MODEL;
    this.timeoutMs = Number(
      this.config.get<string>('INVOICE_AI_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS,
    );
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

    const body = {
      model: this.model,
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { image: toDataUrl(image, mimetype) },
              { text: EXTRACTION_PROMPT },
            ],
          },
        ],
      },
      parameters: {
        ocr_options: {
          task: 'key_information_extraction',
          task_config: { result_schema: EXTRACTION_RESULT_SCHEMA },
        },
        // Las fotos de factura llegan torcidas y boca abajo más veces de las
        // que uno esperaría.
        enable_rotate: true,
      },
    };

    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.baseUrl,
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
      this.logger.error(`Fallo llamando a Qwen: ${message}`);
      throw new ServiceUnavailableException(
        'No se pudo leer la factura: el servicio de lectura no respondió a tiempo.',
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(`Qwen respondió ${response.status}: ${detail.slice(0, 500)}`);
      throw new ServiceUnavailableException(
        'No se pudo leer la factura. Inténtalo de nuevo en un momento.',
      );
    }

    const raw: unknown = await response.json();
    const payload = findInvoicePayload(raw);
    if (!payload) {
      this.logger.warn('Qwen respondió sin un JSON de factura reconocible');
    }
    return {
      raw,
      parsed: parseExtractedInvoice(payload ?? {}),
      model: this.model,
      ms: Date.now() - started,
    };
  }
}
