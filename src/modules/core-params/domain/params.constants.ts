/**
 * Catálogo de parámetros del sistema con vigencia por fecha.
 *
 * Regla no negociable (ver "Orden de desarrollo"): las tarifas, recargos y
 * topes NUNCA se sobrescriben — se versionan por `effectiveFrom`. El valor
 * "vigente" es la versión con la mayor `effectiveFrom <= fecha consultada`.
 */

export const PARAM_VALUE_TYPES = [
  'number',
  'percent',
  'money',
  'text',
  'boolean',
] as const;
export type ParamValueType = (typeof PARAM_VALUE_TYPES)[number];

export const PARAM_GROUPS = [
  'caja',
  'nomina',
  'propina',
  'recargos',
  'operacion',
] as const;
export type ParamGroup = (typeof PARAM_GROUPS)[number];

export interface SeedParam {
  key: string;
  label: string;
  group: ParamGroup;
  valueType: ParamValueType;
  value: number | string | boolean;
  unit?: string;
  note?: string;
}

/**
 * Set base de parámetros que se siembran la primera vez (vigencia 2026-01-01).
 * Todos editables por quien tenga `params.manage`; crear una versión nueva
 * abre una nueva vigencia y conserva el histórico.
 */
export const SEED_PARAMS: SeedParam[] = [
  // Caja
  {
    key: 'caja.tolerancia_descuadre',
    label: 'Tolerancia de descuadre de caja',
    group: 'caja',
    valueType: 'money',
    value: 2000,
    unit: 'COP',
    note: 'Descuadre aceptado sin justificación en el cierre de caja.',
  },
  // Propina
  {
    key: 'propina.sugerida',
    label: 'Propina sugerida',
    group: 'propina',
    valueType: 'percent',
    value: 10,
    unit: '%',
    note: 'Propina voluntaria del 10% (pasivo, rechazable por el cliente).',
  },
  // Recargos (Colombia 2026)
  {
    key: 'recargo.nocturno',
    label: 'Recargo nocturno',
    group: 'recargos',
    valueType: 'percent',
    value: 35,
    unit: '%',
  },
  {
    key: 'recargo.dominical_festivo',
    label: 'Recargo dominical/festivo',
    group: 'recargos',
    valueType: 'percent',
    value: 75,
    unit: '%',
  },
  {
    key: 'recargo.hora_extra_diurna',
    label: 'Hora extra diurna',
    group: 'recargos',
    valueType: 'percent',
    value: 25,
    unit: '%',
  },
  {
    key: 'recargo.hora_extra_nocturna',
    label: 'Hora extra nocturna',
    group: 'recargos',
    valueType: 'percent',
    value: 75,
    unit: '%',
  },
  // Nómina (Colombia 2026)
  {
    key: 'nomina.salario_minimo',
    label: 'Salario mínimo mensual (SMMLV)',
    group: 'nomina',
    valueType: 'money',
    value: 1623500,
    unit: 'COP',
  },
  {
    key: 'nomina.auxilio_transporte',
    label: 'Auxilio de transporte',
    group: 'nomina',
    valueType: 'money',
    value: 200000,
    unit: 'COP',
  },
  // Operación
  {
    key: 'operacion.dias_alerta_vencimiento',
    label: 'Días para alertar vencimiento de lote',
    group: 'operacion',
    valueType: 'number',
    value: 7,
    unit: 'días',
  },
];
