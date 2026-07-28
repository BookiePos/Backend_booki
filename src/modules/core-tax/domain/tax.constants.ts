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

export interface SeedTax {
  code: string;
  name: string;
  kind: TaxKind;
  rate: number;
  note?: string;
}

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
];
