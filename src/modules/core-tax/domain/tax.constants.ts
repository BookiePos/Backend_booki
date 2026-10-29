/**
 * Motor de impuestos configurable por ítem, con vigencias.
 *
 * Colombia: el IVA (19% general, 5% reducido, exento/excluido 0%) aplica a
 * comercio/retail; el consumo en restaurante NO lleva IVA sino INC 8%
 * (impuesto al consumo). Cada tasa se versiona por `effectiveFrom`; nunca se
 * edita una vigencia publicada.
 */

export const TAX_KINDS = ['iva', 'inc', 'exento', 'excluido'] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export const TAX_KIND_LABELS: Record<TaxKind, string> = {
  iva: 'IVA',
  inc: 'Impuesto al consumo (INC)',
  exento: 'Exento (0%)',
  excluido: 'Excluido',
};

/**
 * Cómo se aplica la tarifa: un porcentaje de la base (IVA, INC 8 %) o un valor
 * fijo en pesos por unidad (INC de bolsas plásticas, art. 512-15 ET).
 */
export const TAX_BASES = ['porcentaje', 'por_unidad'] as const;
export type TaxBasis = (typeof TAX_BASES)[number];

export interface SeedTax {
  code: string;
  name: string;
  kind: TaxKind;
  rate: number;
  note?: string;
  /** Sin dato, porcentaje. */
  basis?: TaxBasis;
  /** Sin dato, activo. */
  active?: boolean;
}

/** Código del INC de bolsas plásticas en el catálogo (tributo DIAN `22`). */
export const INC_BOLSAS_CODE = 'INC_BOLSA';

/** Impuestos base sembrados (vigencia 2026-01-01). */
export const SEED_TAXES: SeedTax[] = [
  {
    code: 'IVA_19',
    name: 'IVA general 19%',
    kind: 'iva',
    rate: 19,
    note: 'Tarifa general de IVA para bienes y servicios gravados.',
  },
  {
    code: 'IVA_5',
    name: 'IVA reducido 5%',
    kind: 'iva',
    rate: 5,
    note: 'Tarifa diferencial (algunos alimentos e insumos).',
  },
  {
    code: 'EXENTO',
    name: 'Exento (0%)',
    kind: 'exento',
    rate: 0,
    note: 'Gravado a tarifa 0% (da derecho a descontable).',
  },
  {
    code: 'EXCLUIDO',
    name: 'Excluido',
    kind: 'excluido',
    rate: 0,
    note: 'No causa IVA (sin derecho a descontable).',
  },
  {
    code: 'INC_8',
    name: 'INC restaurante 8%',
    kind: 'inc',
    rate: 8,
    note: 'Impuesto al consumo de restaurantes y bares (no es IVA).',
  },
  /*
   * INC de bolsas plásticas (art. 512-15 ET, tributo DIAN 22): un valor fijo en
   * pesos por bolsa que se entrega para cargar lo vendido, no un porcentaje.
   * La DIAN certifica la tarifa cada año con la variación del IPC; la de 2026
   * es $73 (Circular DIAN 000005 del 16-dic-2025). La del año siguiente se
   * carga como vigencia nueva, sin tocar esta.
   *
   * Nace INACTIVO: ninguna empresa lo cobra hasta que lo active en Impuestos y
   * marque su producto «Bolsa plástica». Las bolsas reutilizables que cumplen
   * el art. 512-16 num. 4 no lo causan.
   */
  {
    code: INC_BOLSAS_CODE,
    name: 'INC bolsas plásticas (por bolsa)',
    kind: 'inc',
    rate: 73,
    basis: 'por_unidad',
    active: false,
    note: 'Art. 512-15 ET. Tarifa 2026: $73 por bolsa (Circular DIAN 000005 de 2025).',
  },
];
