import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EinvoiceEnvironment,
  EinvoiceProvider,
  NumberingRange,
  ProviderResolution,
} from '../application/einvoice-provider';
import type { EinvoiceDocument } from '../domain/einvoice-document';
import type { SendOutcome } from '../domain/send-outcome';
import {
  ApidianCompanyInput,
  interpretApidianResponse,
  toApidianCompany,
  toApidianCreditNote,
  toApidianDebitNote,
  toApidianInvoice,
} from '../domain/apidian-mapper';
import {
  APIDIAN_ENVIRONMENT,
  APIDIAN_TYPE_DOCUMENT,
} from '../domain/apidian-catalogs';

/** Envío y consulta esperan a la DIAN: se les da más margen que al resto. */
const SEND_TIMEOUT_MS = 30_000;
const CONFIG_TIMEOUT_MS = 20_000;

type Json = Record<string, any>;

/**
 * Cliente de APIDIAN (github.com/facturalatam/apidian) instalado en un
 * servidor propio.
 *
 * APIDIAN corre en la misma red privada que el backend y NO se expone a
 * internet: firma con el certificado de cada empresa, así que quien llegue a
 * él puede facturar a nombre de cualquiera. `APIDIAN_URL` apunta a esa
 * dirección interna (p. ej. http://apidian/api).
 *
 * Usa `fetch` global (Node ≥ 20), como el cliente de Wompi.
 */
@Injectable()
export class ApidianClient implements EinvoiceProvider {
  readonly name = 'apidian';
  readonly requiresAccount = true;
  private readonly logger = new Logger(ApidianClient.name);
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('APIDIAN_URL') ?? '').replace(/\/+$/, '');
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  /**
   * Llamada HTTP que NUNCA lanza por la red: devuelve `status: 0` si no hubo
   * respuesta. Quien llama decide qué significa (normalmente, reintentar).
   */
  private async call(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { token?: string; body?: unknown; timeoutMs: number },
  ): Promise<{ status: number; json: Json | undefined }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const json = (await res.json().catch(() => undefined)) as Json | undefined;
      return { status: res.status, json };
    } catch (err) {
      this.logger.warn(
        `APIDIAN ${method} ${path} sin respuesta: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 0, json: undefined };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Para la configuración: cualquier cosa distinta de éxito es un error claro. */
  private async configCall(
    method: 'POST' | 'PUT',
    path: string,
    token: string | undefined,
    body: unknown,
  ): Promise<Json> {
    const { status, json } = await this.call(method, path, {
      token,
      body,
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
    if (status === 0) {
      throw new Error('El servidor de facturación (APIDIAN) no respondió.');
    }
    if (status >= 400 || json?.success === false) {
      const detalle = json?.errors
        ? Object.entries(json.errors as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : String(v)}`)
            .join('; ')
        : (json?.payload ?? json?.message ?? `HTTP ${status}`);
      throw new Error(`APIDIAN rechazó la configuración: ${String(detalle)}`);
    }
    return json ?? {};
  }

  // ── Documentos ────────────────────────────────────────────────────────────────

  async sendInvoice(
    token: string | undefined,
    doc: EinvoiceDocument,
    opts?: { testSetId?: string },
  ): Promise<SendOutcome> {
    const path = opts?.testSetId
      ? `/ubl2.1/invoice/${encodeURIComponent(opts.testSetId)}`
      : '/ubl2.1/invoice';
    const { status, json } = await this.call('POST', path, {
      token,
      body: toApidianInvoice(doc),
      timeoutMs: SEND_TIMEOUT_MS,
    });
    return interpretApidianResponse(status, json);
  }

  async sendCreditNote(
    token: string | undefined,
    doc: EinvoiceDocument,
    opts?: { testSetId?: string },
  ): Promise<SendOutcome> {
    const path = opts?.testSetId
      ? `/ubl2.1/credit-note/${encodeURIComponent(opts.testSetId)}`
      : '/ubl2.1/credit-note';
    const { status, json } = await this.call('POST', path, {
      token,
      body: toApidianCreditNote(doc),
      timeoutMs: SEND_TIMEOUT_MS,
    });
    return interpretApidianResponse(status, json);
  }

  async sendDebitNote(
    token: string | undefined,
    doc: EinvoiceDocument,
    opts?: { testSetId?: string },
  ): Promise<SendOutcome> {
    const path = opts?.testSetId
      ? `/ubl2.1/debit-note/${encodeURIComponent(opts.testSetId)}`
      : '/ubl2.1/debit-note';
    const { status, json } = await this.call('POST', path, {
      token,
      body: toApidianDebitNote(doc),
      timeoutMs: SEND_TIMEOUT_MS,
    });
    return interpretApidianResponse(status, json);
  }

  async getZipStatus(token: string | undefined, zipKey: string): Promise<SendOutcome> {
    const { status, json } = await this.call(
      'POST',
      `/ubl2.1/status/zip/${encodeURIComponent(zipKey)}`,
      {
        token,
        body: { sendmail: false, sendmailtome: false, is_payroll: false, is_eqdoc: false },
        timeoutMs: SEND_TIMEOUT_MS,
      },
    );
    const out = interpretApidianResponse(status, json);
    // Sin veredicto todavía, la DIAN sigue procesando: se consulta otra vez.
    return { ...out, zipKey };
  }

  async getStatus(token: string | undefined, cufe: string): Promise<SendOutcome> {
    const { status, json } = await this.call(
      'POST',
      `/ubl2.1/status/document/${encodeURIComponent(cufe)}`,
      {
        token,
        // Consultar no debe reenviarle el correo al cliente.
        body: { sendmail: false, sendmailtome: false, is_payroll: false, is_eqdoc: false },
        timeoutMs: SEND_TIMEOUT_MS,
      },
    );
    const out = interpretApidianResponse(status, json);
    // La consulta no devuelve el CUFE fuera de la respuesta de la DIAN.
    return { ...out, cufe: out.cufe ?? cufe };
  }

  // ── Habilitación ──────────────────────────────────────────────────────────────

  async configureCompany(input: ApidianCompanyInput): Promise<{ token: string }> {
    const { nit, dv, body } = toApidianCompany(input);
    const json = await this.configCall(
      'POST',
      `/ubl2.1/config/${nit}/${dv}`,
      undefined,
      body,
    );
    const token = json.token ?? json.api_token ?? json.company?.user?.api_token;
    if (!token) {
      throw new Error('APIDIAN creó la empresa pero no devolvió su token.');
    }
    return { token: String(token) };
  }

  async configureCertificate(
    token: string,
    certificateBase64: string,
    password: string,
  ): Promise<{ expiresAt?: string }> {
    const json = await this.configCall('PUT', '/ubl2.1/config/certificate', token, {
      certificate: certificateBase64,
      password,
    });
    const raw: string | undefined = json.certificado?.expiration_date;
    // APIDIAN la devuelve como "AAAA/MM/DD hh:mm:ss".
    return { expiresAt: raw ? raw.replace(/\//g, '-').replace(' ', 'T') : undefined };
  }

  async configureSoftware(token: string, softwareId: string, pin: string): Promise<void> {
    await this.configCall('PUT', '/ubl2.1/config/software', token, {
      id: softwareId,
      pin: Number(pin),
    });
  }

  async configureResolution(token: string, r: ProviderResolution): Promise<void> {
    const body: Json = {
      type_document_id:
        r.kind === 'invoice'
          ? APIDIAN_TYPE_DOCUMENT.INVOICE
          : r.kind === 'credit_note'
            ? APIDIAN_TYPE_DOCUMENT.CREDIT_NOTE
            : APIDIAN_TYPE_DOCUMENT.DEBIT_NOTE,
      prefix: r.prefix,
      from: r.from,
      to: r.to,
    };
    if (r.kind === 'invoice') {
      Object.assign(body, {
        resolution: r.resolutionNumber,
        resolution_date: r.resolutionDate,
        technical_key: r.technicalKey,
        date_from: r.dateFrom,
        date_to: r.dateTo,
        generated_to_date: 0,
      });
    }
    await this.configCall('PUT', '/ubl2.1/config/resolution', token, body);
  }

  async setEnvironment(token: string, env: EinvoiceEnvironment): Promise<void> {
    const id =
      env === 'produccion'
        ? APIDIAN_ENVIRONMENT.PRODUCCION
        : APIDIAN_ENVIRONMENT.HABILITACION;
    await this.configCall('PUT', '/ubl2.1/config/environment', token, {
      type_environment_id: id,
    });
  }

  async getNumberingRanges(token: string, softwareId: string): Promise<NumberingRange[]> {
    const json = await this.configCall('POST', '/ubl2.1/numbering-range', token, {
      IDSoftware: softwareId,
    });
    const result =
      json.ResponseDian?.Envelope?.Body?.GetNumberingRangeResponse
        ?.GetNumberingRangeResult;
    const list = result?.ResponseList?.NumberRangeResponse;
    const items: Json[] = !list ? [] : Array.isArray(list) ? list : [list];
    return items.map((x) => ({
      resolutionNumber: String(x.ResolutionNumber ?? ''),
      resolutionDate: x.ResolutionDate ? String(x.ResolutionDate) : undefined,
      prefix: String(x.Prefix ?? ''),
      from: Number(x.FromNumber ?? 0),
      to: Number(x.ToNumber ?? 0),
      dateFrom: x.ValidDateFrom ? String(x.ValidDateFrom) : undefined,
      dateTo: x.ValidDateTo ? String(x.ValidDateTo) : undefined,
      technicalKey: x.TechnicalKey ? String(x.TechnicalKey) : undefined,
    }));
  }

  async downloadFile(
    token: string | undefined,
    nit: string,
    fileName: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${this.baseUrl}/download/${encodeURIComponent(nit)}/${encodeURIComponent(fileName)}`,
        {
          signal: ctrl.signal,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      if (!res.ok) {
        throw new Error(`APIDIAN no entregó el archivo (HTTP ${res.status}).`);
      }
      return {
        data: Buffer.from(await res.arrayBuffer()),
        contentType:
          res.headers.get('content-type') ??
          (fileName.endsWith('.pdf') ? 'application/pdf' : 'application/xml'),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
