import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  WompiConfig,
  isWompiConfigured,
  wompiConfig,
} from '../domain/wompi.config';
import { WOMPI_CURRENCY } from '../domain/billing.constants';

export interface WompiTransaction {
  id: string;
  status: string;
  reference: string;
  amount_in_cents: number;
}

interface WompiEvent {
  event?: string;
  data?: Record<string, unknown>;
  timestamp?: number;
  signature?: { checksum?: string; properties?: string[] };
}

/**
 * Cliente HTTP de la API de Wompi (Colombia). Usa `fetch` global (Node ≥ 20).
 * - Tokenización de tarjeta y acceptance token: llave PÚBLICA.
 * - Fuentes de pago, transacciones y consultas: llave PRIVADA.
 * - Firma de integridad para crear transacciones y validación del checksum de
 *   los eventos del webhook.
 */
@Injectable()
export class WompiClient {
  private readonly logger = new Logger(WompiClient.name);
  private readonly cfg: WompiConfig;

  constructor(config: ConfigService) {
    this.cfg = wompiConfig(config);
  }

  get publicKey(): string {
    return this.cfg.publicKey;
  }

  get environment(): string {
    return this.cfg.environment;
  }

  get configured(): boolean {
    return isWompiConfigured(this.cfg);
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, init);
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok) {
      this.logger.error(
        `Wompi ${path} → ${res.status}: ${JSON.stringify(json ?? {})}`,
      );
      throw new Error(`Wompi respondió ${res.status}`);
    }
    return json ?? {};
  }

  private data(json: Record<string, unknown>): Record<string, unknown> {
    return (json.data ?? {}) as Record<string, unknown>;
  }

  /** Acceptance token vigente del comercio (el usuario debe aceptar los T&C). */
  async getAcceptance(): Promise<{ acceptanceToken: string; permalink: string }> {
    const json = await this.request(`/merchants/${this.cfg.publicKey}`, {
      method: 'GET',
    });
    const merchant = this.data(json);
    const presigned = (merchant.presigned_acceptance ?? {}) as Record<
      string,
      unknown
    >;
    return {
      acceptanceToken: String(presigned.acceptance_token ?? ''),
      permalink: String(presigned.permalink ?? ''),
    };
  }

  /**
   * Tokeniza una tarjeta con la llave PÚBLICA. Normalmente lo hace el frontend;
   * se expone para pruebas de sandbox de punta a punta desde el backend.
   */
  async tokenizeCard(card: {
    number: string;
    cvc: string;
    exp_month: string;
    exp_year: string;
    card_holder: string;
  }): Promise<string> {
    const json = await this.request('/tokens/cards', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.publicKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(card),
    });
    return String(this.data(json).id ?? '');
  }

  /** Crea una fuente de pago reutilizable (tarjeta) con la llave PRIVADA. */
  async createPaymentSource(input: {
    token: string;
    customerEmail: string;
    acceptanceToken: string;
  }): Promise<number> {
    const json = await this.request('/payment_sources', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.privateKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'CARD',
        token: input.token,
        customer_email: input.customerEmail,
        acceptance_token: input.acceptanceToken,
      }),
    });
    return Number(this.data(json).id);
  }

  /** Firma de integridad: SHA256(reference + amount + currency + secret). */
  integritySignature(reference: string, amountInCents: number): string {
    return createHash('sha256')
      .update(
        `${reference}${amountInCents}${WOMPI_CURRENCY}${this.cfg.integritySecret}`,
      )
      .digest('hex');
  }

  /** Cobra contra una fuente de pago (transacción server-to-server). */
  async createTransaction(input: {
    amountInCents: number;
    reference: string;
    customerEmail: string;
    paymentSourceId: number;
  }): Promise<WompiTransaction> {
    const signature = this.integritySignature(
      input.reference,
      input.amountInCents,
    );
    const json = await this.request('/transactions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.privateKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount_in_cents: input.amountInCents,
        currency: WOMPI_CURRENCY,
        customer_email: input.customerEmail,
        payment_source_id: input.paymentSourceId,
        reference: input.reference,
        payment_method: { installments: 1 },
        signature,
      }),
    });
    return this.data(json) as unknown as WompiTransaction;
  }

  async getTransaction(id: string): Promise<WompiTransaction> {
    const json = await this.request(`/transactions/${id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.cfg.privateKey}` },
    });
    return this.data(json) as unknown as WompiTransaction;
  }

  /**
   * Valida el checksum de un evento del webhook. Wompi lo calcula como
   * SHA256(concat(valores de `signature.properties`) + timestamp + eventsSecret).
   */
  verifyEvent(event: WompiEvent): boolean {
    const properties = event.signature?.properties;
    const checksum = event.signature?.checksum;
    if (!properties || !checksum || event.timestamp === undefined) {
      return false;
    }
    const concat = properties
      .map((path) => String(this.resolve(event.data ?? {}, path) ?? ''))
      .join('');
    const raw = `${concat}${event.timestamp}${this.cfg.eventsSecret}`;
    const computed = createHash('sha256').update(raw).digest('hex');
    return computed.toUpperCase() === String(checksum).toUpperCase();
  }

  /** Resuelve una ruta tipo "transaction.status" dentro de `data`. */
  private resolve(obj: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }
}
