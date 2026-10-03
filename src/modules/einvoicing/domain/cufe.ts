import type { EinvoiceEnvironmentName } from './einvoicing.constants';

/**
 * URL pública de verificación de la DIAN a partir del CUFE.
 *
 * El CUFE ya no se calcula aquí: el que vale es el que devuelve la DIAN al
 * validar el documento (antes BookiPos lo calculaba localmente y la factura
 * nunca se enviaba). Esta URL solo se usa cuando el facturador no devolvió la
 * suya, por ejemplo al recuperar el estado de un documento por consulta.
 */
export function dianVerificationUrl(
  cufe: string,
  environment: EinvoiceEnvironmentName = 'produccion',
): string {
  const host =
    environment === 'produccion'
      ? 'catalogo-vpfe.dian.gov.co'
      : 'catalogo-vpfe-hab.dian.gov.co';
  return `https://${host}/document/searchqr?documentkey=${cufe}`;
}
