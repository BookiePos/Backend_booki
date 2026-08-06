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

/**
 * Catálogo de grupos de parámetros. Es EXTENSIBLE: para abrir una categoría
 * nueva basta con añadirla a esta lista (más las etiquetas en
 * `PARAM_GROUP_LABELS`). La validación (schema + DTO) se apoya en esta misma
 * constante, así que no hay enums duplicados regados por el código.
 */
export const PARAM_GROUPS = [
  'caja',
  'nomina',
  'propina',
  'recargos',
  'operacion',
  'fiscal',
  'pos',
  'inventario',
  'finanzas',
  'facturacion',
  'sistema',
] as const;
export type ParamGroup = (typeof PARAM_GROUPS)[number];

/** Etiquetas legibles de cada grupo (para UI / agrupaciones). */
export const PARAM_GROUP_LABELS: Record<ParamGroup, string> = {
  caja: 'Caja',
  nomina: 'Nómina',
  propina: 'Propina',
  recargos: 'Recargos',
  operacion: 'Operación',
  fiscal: 'Fiscal / Retenciones',
  pos: 'Punto de venta',
  inventario: 'Inventario',
  finanzas: 'Finanzas',
  facturacion: 'Facturación / DIAN',
  sistema: 'Sistema',
};

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
    value: 90,
    unit: '%',
    note: 'Ley 2466/2025: 90% desde el 2º semestre 2026.',
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
    value: 1750905,
    unit: 'COP',
    note: 'SMMLV Colombia 2026 (Decreto 1469/2025).',
  },
  {
    key: 'nomina.auxilio_transporte',
    label: 'Auxilio de transporte',
    group: 'nomina',
    valueType: 'money',
    value: 249095,
    unit: 'COP',
    note: 'Auxilio de transporte Colombia 2026 (Decreto 1470/2025).',
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

  // ── Fiscal / Retenciones (Colombia 2026) ────────────────────────────────────
  {
    key: 'fiscal.retefuente_compras_pct',
    label: 'Retención en la fuente por compras',
    group: 'fiscal',
    valueType: 'percent',
    value: 2.5,
    unit: '%',
    note: 'Tarifa general de retefuente por compras (declarantes).',
  },
  {
    key: 'fiscal.reteiva_pct',
    label: 'Retención de IVA (ReteIVA)',
    group: 'fiscal',
    valueType: 'percent',
    value: 15,
    unit: '%',
    note: 'Porcentaje de retención sobre el IVA facturado.',
  },
  {
    key: 'fiscal.uvt',
    label: 'UVT (Unidad de Valor Tributario)',
    group: 'fiscal',
    valueType: 'money',
    value: 52374,
    unit: 'COP',
    note: 'UVT 2026 (Resolución DIAN 000238/2025).',
  },
  {
    key: 'fiscal.responsable_iva',
    label: 'Responsable de IVA',
    group: 'fiscal',
    valueType: 'boolean',
    value: true,
    note: 'La empresa es responsable de IVA (antes régimen común).',
  },

  // ── Punto de venta (POS) ────────────────────────────────────────────────────
  {
    key: 'pos.propina_sugerida',
    label: 'Propina sugerida (POS)',
    group: 'pos',
    valueType: 'percent',
    value: 10,
    unit: '%',
    note: 'Propina sugerida por defecto en el POS (editable/rechazable).',
  },
  {
    key: 'pos.propina_editable',
    label: 'Propina editable',
    group: 'pos',
    valueType: 'boolean',
    value: true,
    note: 'Permite al cajero modificar/rechazar la propina.',
  },
  {
    key: 'pos.descuento_max_sin_aprobacion_pct',
    label: 'Descuento máximo sin aprobación',
    group: 'pos',
    valueType: 'percent',
    value: 10,
    unit: '%',
    note: 'Tope de descuento que el cajero aplica sin aprobación.',
  },

  // ── Inventario ──────────────────────────────────────────────────────────────
  {
    key: 'inventario.metodo_costeo',
    label: 'Método de costeo',
    group: 'inventario',
    valueType: 'text',
    value: 'promedio',
    note: 'Método de costeo de inventario (promedio, fifo, etc.).',
  },
  {
    key: 'inventario.permite_stock_negativo',
    label: 'Permite stock negativo',
    group: 'inventario',
    valueType: 'boolean',
    value: false,
    note: 'Permite vender por debajo de la existencia disponible.',
  },
  {
    key: 'inventario.dias_reorden',
    label: 'Días de reorden',
    group: 'inventario',
    valueType: 'number',
    value: 15,
    unit: 'días',
    note: 'Cobertura objetivo para sugerir reposición.',
  },

  // ── Finanzas ────────────────────────────────────────────────────────────────
  {
    key: 'finanzas.moneda',
    label: 'Moneda',
    group: 'finanzas',
    valueType: 'text',
    value: 'COP',
    note: 'Moneda funcional del sistema.',
  },
  {
    key: 'finanzas.decimales_moneda',
    label: 'Decimales de moneda',
    group: 'finanzas',
    valueType: 'number',
    value: 0,
    note: 'Cantidad de decimales al mostrar montos (COP = 0).',
  },
  {
    key: 'finanzas.dias_gracia_cxc',
    label: 'Días de gracia CxC',
    group: 'finanzas',
    valueType: 'number',
    value: 30,
    unit: 'días',
    note: 'Plazo por defecto de las cuentas por cobrar (fiado).',
  },
  {
    key: 'finanzas.dias_credito_cxp',
    label: 'Días de crédito CxP',
    group: 'finanzas',
    valueType: 'number',
    value: 30,
    unit: 'días',
    note: 'Plazo por defecto de las cuentas por pagar.',
  },

  // ── Facturación / DIAN ──────────────────────────────────────────────────────
  {
    key: 'dian.ambiente',
    label: 'Ambiente DIAN',
    group: 'facturacion',
    valueType: 'text',
    value: 'habilitacion',
    note: 'Ambiente de facturación electrónica (habilitacion | produccion).',
  },
  {
    key: 'dian.regimen',
    label: 'Régimen',
    group: 'facturacion',
    valueType: 'text',
    value: 'comun',
    note: 'Régimen tributario (comun | simplificado | simple).',
  },
  {
    key: 'dian.prefijo_pos',
    label: 'Prefijo POS',
    group: 'facturacion',
    valueType: 'text',
    value: 'POS',
    note: 'Prefijo de numeración para documentos POS.',
  },

  // ── Sistema ─────────────────────────────────────────────────────────────────
  {
    key: 'sistema.zona_horaria',
    label: 'Zona horaria',
    group: 'sistema',
    valueType: 'text',
    value: 'America/Bogota',
    note: 'Zona horaria para fechas de vigencia y reportes.',
  },
  {
    key: 'sistema.consecutivo_por_sede',
    label: 'Consecutivo por sede',
    group: 'sistema',
    valueType: 'boolean',
    value: true,
    note: 'La numeración de documentos es independiente por sede.',
  },
];
