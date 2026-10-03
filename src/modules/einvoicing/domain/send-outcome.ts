/**
 * Qué pasó al mandar (o consultar) un documento ante la DIAN.
 *
 * Distinguir bien estos casos es lo que evita los dos errores caros: dar por
 * buena una factura que la DIAN rechazó, y reenviar con número nuevo una que
 * en realidad ya había entrado.
 *
 * - `accepted`  la DIAN la validó. Tiene CUFE oficial.
 * - `rejected`  la DIAN (o el proveedor, por datos inválidos) la rechazó. No
 *               sirve reintentar igual: hay que corregir y reenviar.
 * - `pending`   no se sabe todavía: la DIAN o el proveedor no respondieron.
 *               Se reintenta solo. Si ya hay CUFE, se CONSULTA en vez de
 *               reenviar.
 * - `duplicate` el documento ya había entrado antes. Se consulta su estado
 *               por CUFE.
 * - `failed`    falla de configuración (certificado vencido, token inválido,
 *               conexión sin configurar). Reintentar no sirve hasta que
 *               alguien la arregle.
 *
 * Dominio puro.
 */
export type SendStatus =
  | 'accepted'
  | 'rejected'
  | 'pending'
  | 'duplicate'
  | 'failed';

export interface SendOutcome {
  status: SendStatus;
  /** CUFE/CUDE, si se conoce. */
  cufe?: string;
  /** URL de verificación (QR) que devolvió el proveedor. */
  qrUrl?: string;
  /** Mensaje corto y legible para mostrar. */
  message: string;
  /** Reglas incumplidas o errores de validación, uno por renglón. */
  errors: string[];
  /** Archivos que dejó el proveedor (para descargar luego). */
  files?: { pdf?: string; xml?: string; attached?: string };
  /** Días que le quedan al certificado, si el proveedor lo informa. */
  certificateDaysLeft?: number;
}
