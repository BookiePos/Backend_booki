import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  EinvoiceProvider,
  NumberingRange,
} from '../application/einvoice-provider';
import type { EinvoiceDocument } from '../domain/einvoice-document';
import type { SendOutcome } from '../domain/send-outcome';
import { toApidianCreditNote, toApidianInvoice } from '../domain/apidian-mapper';

/**
 * Proveedor de mentiras para desarrollo, demos y pruebas.
 *
 * Acepta todo sin salir a la red ni pedir certificado: deja recorrer el flujo
 * completo del POS sin una DIAN real. Igual pasa cada documento por el
 * traductor de APIDIAN, así que un documento que el traductor no pueda armar
 * falla aquí también y no se descubre recién en producción.
 *
 * Sus CUFE son un hash del documento y NO valen ante la DIAN. Nunca debe
 * quedar activo en producción (`EINVOICING_PROVIDER=apidian`).
 */
@Injectable()
export class FakeEinvoiceProvider implements EinvoiceProvider {
  readonly name = 'simulado';
  readonly enabled = true;
  readonly requiresAccount = false;

  private accept(doc: EinvoiceDocument, payload: unknown): SendOutcome {
    const cufe = createHash('sha384')
      .update(JSON.stringify(payload))
      .digest('hex');
    return {
      status: 'accepted',
      cufe,
      qrUrl: `https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${cufe}`,
      message: 'Aceptada (simulación: no se envió a la DIAN).',
      errors: [],
      files: {
        pdf: `FES-${doc.prefix}${doc.number}.pdf`,
        xml: `FES-${doc.prefix}${doc.number}.xml`,
      },
    };
  }

  async sendInvoice(_token: string | undefined, doc: EinvoiceDocument) {
    return this.accept(doc, toApidianInvoice(doc));
  }

  async sendCreditNote(_token: string | undefined, doc: EinvoiceDocument) {
    return this.accept(doc, toApidianCreditNote(doc));
  }

  async getStatus(_token: string | undefined, cufe: string): Promise<SendOutcome> {
    return {
      status: 'accepted',
      cufe,
      message: 'Aceptada (simulación).',
      errors: [],
    };
  }

  async configureCompany(): Promise<{ token: string }> {
    return { token: 'token-simulado' };
  }

  async configureCertificate(): Promise<{ expiresAt?: string }> {
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    return { expiresAt: nextYear.toISOString() };
  }

  async configureSoftware(): Promise<void> {}
  async configureResolution(): Promise<void> {}
  async setEnvironment(): Promise<void> {}

  async getNumberingRanges(): Promise<NumberingRange[]> {
    return [];
  }

  async downloadFile(): Promise<{ data: Buffer; contentType: string }> {
    throw new Error(
      'La facturación está en modo simulación: no hay PDF ni XML de la DIAN.',
    );
  }
}
