import type { EinvoiceDocument } from '../domain/einvoice-document';
import type { SendOutcome } from '../domain/send-outcome';
import type { ApidianCompanyInput } from '../domain/apidian-mapper';

/** Token de inyección: qué implementación se usa lo decide el módulo. */
export const EINVOICE_PROVIDER = Symbol('EINVOICE_PROVIDER');

/** Ambiente DIAN de una empresa. */
export type EinvoiceEnvironment = 'habilitacion' | 'produccion';

/** Resolución tal como se registra en el proveedor. */
export interface ProviderResolution {
  kind: 'invoice' | 'credit_note';
  prefix: string;
  from: number;
  to: number;
  /** Solo facturas: los datos del documento de la DIAN. */
  resolutionNumber?: string;
  resolutionDate?: string;
  technicalKey?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** Rango de numeración que la DIAN tiene asociado a un software. */
export interface NumberingRange {
  resolutionNumber: string;
  resolutionDate?: string;
  prefix: string;
  from: number;
  to: number;
  dateFrom?: string;
  dateTo?: string;
  technicalKey?: string;
}

/**
 * Quien firma y transmite los documentos a la DIAN.
 *
 * Hoy hay dos implementaciones: APIDIAN (la real, instalada en un servidor
 * propio) y una falsa para desarrollo y pruebas, que acepta todo sin salir a
 * la red. Se escoge con `EINVOICING_PROVIDER`; el resto del código habla solo
 * con esta interfaz, así que cambiar de proveedor es escribir otra
 * implementación, no tocar el servicio.
 *
 * `token` es la credencial de la EMPRESA en el proveedor (una por NIT).
 */
export interface EinvoiceProvider {
  /** Nombre legible, para el historial del documento. */
  readonly name: string;
  /** ¿Está configurado? Sin URL, el módulo responde con mensaje claro. */
  readonly enabled: boolean;
  /**
   * ¿Exige que la empresa haya hecho la habilitación? El falso no: deja
   * facturar en desarrollo sin certificado ni DIAN.
   */
  readonly requiresAccount: boolean;

  sendInvoice(
    token: string | undefined,
    doc: EinvoiceDocument,
    opts?: { testSetId?: string },
  ): Promise<SendOutcome>;

  sendCreditNote(
    token: string | undefined,
    doc: EinvoiceDocument,
    opts?: { testSetId?: string },
  ): Promise<SendOutcome>;

  /** Consulta por CUFE/CUDE lo que la DIAN tiene de un documento. */
  getStatus(token: string | undefined, cufe: string): Promise<SendOutcome>;

  // ── Habilitación ────────────────────────────────────────────────────────────

  /** Crea o actualiza la empresa. Devuelve el token de la empresa. */
  configureCompany(input: ApidianCompanyInput): Promise<{ token: string }>;
  /** Certificado digital (.p12/.pfx) en base64 con su clave. */
  configureCertificate(
    token: string,
    certificateBase64: string,
    password: string,
  ): Promise<{ expiresAt?: string }>;
  /** ID y PIN del software propio registrado en la DIAN. */
  configureSoftware(token: string, softwareId: string, pin: string): Promise<void>;
  configureResolution(token: string, r: ProviderResolution): Promise<void>;
  setEnvironment(token: string, env: EinvoiceEnvironment): Promise<void>;
  /** Rangos que la DIAN asoció al software (trae la clave técnica). */
  getNumberingRanges(token: string, softwareId: string): Promise<NumberingRange[]>;

  /** Descarga un archivo del documento (PDF o XML) que guardó el proveedor. */
  downloadFile(
    token: string | undefined,
    nit: string,
    fileName: string,
  ): Promise<{ data: Buffer; contentType: string }>;
}
