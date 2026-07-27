/** Tipo de persona del emisor (factura electrónica DIAN). */
export const TIPO_PERSONA = ['natural', 'juridica'] as const;
export type TipoPersona = (typeof TIPO_PERSONA)[number];

/**
 * Responsabilidad fiscal / régimen del emisor (simplificado para el operador).
 * Se mapea a los códigos DIAN en la integración con el proveedor tecnológico.
 */
export const RESPONSABILIDAD_FISCAL = [
  'responsable_iva',
  'no_responsable_iva',
  'regimen_simple',
  'gran_contribuyente',
] as const;
export type ResponsabilidadFiscal = (typeof RESPONSABILIDAD_FISCAL)[number];
