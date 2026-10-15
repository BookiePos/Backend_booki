/**
 * Parámetros y tipos del motor de nómina (Colombia). TODO valor que cambia por
 * año o reforma vive aquí como dato configurable (no hardcode en el cálculo).
 * Valores por defecto = vigentes 2026 (confirmados: Decretos 1469/1470 de 2025,
 * Resolución DIAN 000238/2025, Ley 2466 de 2025, Ley 2101 de 2021).
 */

export interface FspTramo {
  /** Límite superior del tramo en SMMLV (null = sin tope). */
  hastaSmmlv: number | null;
  rate: number;
}

export interface RetTramo {
  desdeUvt: number;
  hastaUvt: number | null;
  rate: number;
  /** UVT acumuladas de los tramos anteriores (tabla art. 383). */
  uvtBase: number;
}

export interface ArlRates {
  I: number;
  II: number;
  III: number;
  IV: number;
  V: number;
}

/** Factores de recargo/hora extra (recargo adicional sobre la hora ordinaria). */
export interface RecargoFactores {
  recargoNocturno: number;
  dominical: number;
  nocturnoDominical: number;
  extraDiurna: number;
  extraNocturna: number;
  extraDiurnaDominical: number;
  extraNocturnaDominical: number;
}

/**
 * Jornada máxima semanal vigente desde una fecha (YYYY-MM-DD). Rige hasta el
 * `desde` del tramo siguiente.
 */
export interface JornadaTramo {
  desde: string;
  horasSemana: number;
}

/**
 * Reducción gradual de la jornada máxima legal (Ley 2101 de 2021, art. 3, que
 * modificó el art. 161 CST; la ley rige desde el 15-jul-2021). Antes del primer
 * tramo rige la jornada de 48 h del texto anterior del art. 161.
 */
export const JORNADA_MAXIMA_ANTERIOR = 48;
export const JORNADA_TRAMOS_LEY_2101: JornadaTramo[] = [
  { desde: '2023-07-15', horasSemana: 47 },
  { desde: '2024-07-15', horasSemana: 46 },
  { desde: '2025-07-15', horasSemana: 44 },
  { desde: '2026-07-15', horasSemana: 42 },
];

/** Valor de un recargo vigente desde una fecha (YYYY-MM-DD). */
export interface RecargoTramo {
  desde: string;
  factor: number;
}

/**
 * Recargo por trabajo en día de descanso obligatorio (dominical o festivo).
 * Art. 179 CST, modificado por la Ley 2466 de 2025, art. 14, parágrafo
 * transitorio: 80 % desde el 1-jul-2025, 90 % desde el 1-jul-2026 y 100 %
 * («plena aplicación») desde el 1-jul-2027. Antes rige el 75 % del texto que
 * dejó el art. 26 de la Ley 789 de 2002.
 */
export const RECARGO_DOMINICAL_ANTERIOR = 0.75;
export const RECARGO_DOMINICAL_LEY_2466: RecargoTramo[] = [
  { desde: '2025-07-01', factor: 0.8 },
  { desde: '2026-07-01', factor: 0.9 },
  { desde: '2027-07-01', factor: 1 },
];

/**
 * Recargos mínimos del art. 168 CST: nocturno 35 %, extra diurna 25 %, extra
 * nocturna 75 %. Lo configurado solo puede subirlos (CST art. 13: mínimos).
 */
export const RECARGOS_MINIMOS_ART_168 = {
  recargoNocturno: 0.35,
  extraDiurna: 0.25,
  extraNocturna: 0.75,
} as const;

/** Hora (0-23) en que empieza el trabajo nocturno desde una fecha. */
export interface FranjaNocturnaTramo {
  desde: string;
  desdeHora: number;
}

/**
 * Inicio de la franja nocturna. Art. 160 CST, modificado por la Ley 2466 de
 * 2025, art. 10: nocturno de 7 p.m. a 6 a.m., vigente seis meses después de la
 * sanción (25-jun-2025), es decir, desde el 25-dic-2025 (parágrafo 2). Antes
 * rige el texto de la Ley 1846 de 2017: de 9 p.m. a 6 a.m.
 */
export const NOCTURNO_DESDE_HORA_ANTERIOR = 21;
export const FRANJA_NOCTURNA_LEY_2466: FranjaNocturnaTramo[] = [
  { desde: '2025-12-25', desdeHora: 19 },
];
export const NOCTURNO_HASTA_HORA = 6;

export interface PayrollSettingsData {
  year: number;
  smmlv: number;
  auxilioTransporte: number;
  uvt: number;

  saludEmpleado: number;
  saludEmpleador: number;
  pensionEmpleado: number;
  pensionEmpleador: number;

  ccf: number;
  sena: number;
  icbf: number;
  arlRates: ArlRates;

  ibcMinSmmlv: number;
  ibcMaxSmmlv: number;
  integralSmmlv: number;
  integralIbcFactor: number;
  exoneracionSmmlv: number;
  auxTransporteMaxSmmlv: number;

  fspTramos: FspTramo[];

  cesantias: number;
  interesesCesantias: number;
  prima: number;
  vacaciones: number;

  tabla383: RetTramo[];
  retencionUmbralUvt: number;
  depMaxUvt: number;
  viviendaMaxUvt: number;
  prepagadaMaxUvt: number;
  rentaExentaPorc: number;
  rentaExentaMaxUvtMes: number;
  limiteGlobalPorc: number;
  limiteGlobalUvtMes: number;

  recargos: RecargoFactores;

  /**
   * Jornadas PACTADAS por la empresa, por vigencia (art. 161 CST permite
   * pactar por debajo de la máxima legal, nunca por encima). La tabla legal no
   * se copia aquí: vive en `JORNADA_TRAMOS_LEY_2101` y la jornada vigente es el
   * menor entre el pacto vigente y el tramo legal vigente (`jornadaSemanalVigente`).
   * Los expedientes guardados antes copiaban la tabla legal; esas filas se
   * ignoran al leer.
   */
  jornadaTramos?: JornadaTramo[];

  /**
   * Recargo dominical/festivo pactado por encima del legal (factor). No se
   * guarda en el expediente: lo pone `PayrollService` desde la vigencia de
   * `recargo.dominical_festivo` que haya creado una persona en Parámetros. El
   * legal por fecha (`RECARGO_DOMINICAL_LEY_2466`) es el piso; `recargos.dominical`
   * y los combinados del expediente ya no se leen.
   */
  recargoDominicalPactado?: number;

  /** La empresa está sujeta a exoneración de aportes (art. 114-1 ET). */
  empresaExoneradaAportes: boolean;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettingsData = {
  year: 2026,
  smmlv: 1750905,
  auxilioTransporte: 249095,
  uvt: 52374,

  saludEmpleado: 0.04,
  saludEmpleador: 0.085,
  pensionEmpleado: 0.04,
  pensionEmpleador: 0.12,

  ccf: 0.04,
  sena: 0.02,
  icbf: 0.03,
  arlRates: {
    I: 0.00522,
    II: 0.01044,
    III: 0.02436,
    IV: 0.0435,
    V: 0.0696,
  },

  ibcMinSmmlv: 1,
  ibcMaxSmmlv: 25,
  integralSmmlv: 13,
  integralIbcFactor: 0.7,
  exoneracionSmmlv: 10,
  auxTransporteMaxSmmlv: 2,

  // Fondo de Solidaridad Pensional (aplica si IBC >= 4 SMMLV).
  fspTramos: [
    { hastaSmmlv: 16, rate: 0.01 },
    { hastaSmmlv: 17, rate: 0.012 },
    { hastaSmmlv: 18, rate: 0.014 },
    { hastaSmmlv: 19, rate: 0.016 },
    { hastaSmmlv: 20, rate: 0.018 },
    { hastaSmmlv: null, rate: 0.02 },
  ],

  cesantias: 0.0833,
  interesesCesantias: 0.12,
  prima: 0.0833,
  vacaciones: 0.0417,

  // Tabla de retención en la fuente art. 383 ET (base en UVT).
  tabla383: [
    { desdeUvt: 0, hastaUvt: 95, rate: 0, uvtBase: 0 },
    { desdeUvt: 95, hastaUvt: 150, rate: 0.19, uvtBase: 0 },
    { desdeUvt: 150, hastaUvt: 360, rate: 0.28, uvtBase: 10 },
    { desdeUvt: 360, hastaUvt: 640, rate: 0.33, uvtBase: 69 },
    { desdeUvt: 640, hastaUvt: 945, rate: 0.35, uvtBase: 162 },
    { desdeUvt: 945, hastaUvt: 2300, rate: 0.37, uvtBase: 268 },
    { desdeUvt: 2300, hastaUvt: null, rate: 0.39, uvtBase: 770 },
  ],
  retencionUmbralUvt: 95,
  depMaxUvt: 32,
  viviendaMaxUvt: 100,
  prepagadaMaxUvt: 16,
  rentaExentaPorc: 0.25,
  rentaExentaMaxUvtMes: 790 / 12,
  limiteGlobalPorc: 0.4,
  limiteGlobalUvtMes: 1340 / 12,

  // Recargos del art. 168 CST. El dominical y los combinados se calculan por
  // fecha (`recargosVigentes`); estos valores quedan solo como referencia.
  recargos: {
    recargoNocturno: 0.35,
    dominical: 0.9,
    nocturnoDominical: 1.25,
    extraDiurna: 0.25,
    extraNocturna: 0.75,
    extraDiurnaDominical: 1.15,
    extraNocturnaDominical: 1.65,
  },

  jornadaTramos: [],

  empresaExoneradaAportes: true,
};

export const DIAS_MES = 30;
