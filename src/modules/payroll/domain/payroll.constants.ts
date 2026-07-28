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

  // Recargos Ley 2466/2025 (2026 2º semestre: dominical 90%). Editables.
  recargos: {
    recargoNocturno: 0.35,
    dominical: 0.9,
    nocturnoDominical: 1.25,
    extraDiurna: 0.25,
    extraNocturna: 0.75,
    extraDiurnaDominical: 1.15,
    extraNocturnaDominical: 1.65,
  },

  empresaExoneradaAportes: true,
};

export const HORAS_MES = 240;
export const DIAS_MES = 30;
