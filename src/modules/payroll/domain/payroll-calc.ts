/**
 * Motor de cálculo de nómina mensual (Colombia). Funciones puras: reciben los
 * datos del empleado + novedades del período y los parámetros vigentes, y
 * devuelven el desprendible completo (devengados, deducciones, aportes del
 * empleador y provisiones prestacionales). Nada de acceso a BD aquí.
 */
import {
  DIAS_MES,
  JORNADA_MAXIMA_ANTERIOR,
  JORNADA_TRAMOS_LEY_2101,
  JornadaTramo,
  PayrollSettingsData,
  RECARGO_DOMINICAL_ANTERIOR,
  RECARGO_DOMINICAL_LEY_2466,
  RECARGOS_MINIMOS_ART_168,
  RecargoFactores,
} from './payroll.constants';

export type SalaryType = 'ordinario' | 'integral';
export type ArlLevel = 'I' | 'II' | 'III' | 'IV' | 'V';

/** Horas de trabajo suplementario por tipo (recargos y extras). */
export interface NovedadHoras {
  recargoNocturno?: number;
  dominical?: number;
  nocturnoDominical?: number;
  extraDiurna?: number;
  extraNocturna?: number;
  extraDiurnaDominical?: number;
  extraNocturnaDominical?: number;
}

export interface PayrollNovedades {
  horas?: NovedadHoras;
  bonificacionSalarial?: number;
  bonificacionNoSalarial?: number;
  comisiones?: number;
  otrasDeducciones?: number;
  /** Deducción de renta por dependientes (10% del ingreso, tope legal). */
  dependientes?: boolean;
  deduccionVivienda?: number;
  deduccionPrepagada?: number;
}

export interface PayrollInput {
  salarioBase: number;
  salaryType: SalaryType;
  diasTrabajados: number;
  arlRiskLevel?: ArlLevel;
  novedades?: PayrollNovedades;
  /**
   * Fecha (YYYY-MM-DD) con la que se elige la jornada vigente y, con ella, el
   * divisor del valor hora. En una corrida es el último día del período
   * (`fechaCorteDePeriodo`); sin ella se usa hoy en Colombia.
   */
  fechaCorte?: string;
}

export interface RecargoLinea {
  key: string;
  label: string;
  horas: number;
  factor: number;
  valor: number;
}

export interface PayrollBreakdown {
  diasTrabajados: number;
  /** Horas mensuales con que se dividió el salario (jornada vigente / 6 × 30). */
  divisorHoras: number;
  horaOrdinaria: number;
  devengados: {
    salario: number;
    auxilioTransporte: number;
    recargos: number;
    horasExtra: number;
    recargoDetalle: RecargoLinea[];
    bonificacionSalarial: number;
    bonificacionNoSalarial: number;
    comisiones: number;
    total: number;
  };
  ibc: number;
  deducciones: {
    salud: number;
    pension: number;
    fsp: number;
    retencionFuente: number;
    otras: number;
    total: number;
  };
  aportesEmpleador: {
    salud: number;
    pension: number;
    arl: number;
    ccf: number;
    sena: number;
    icbf: number;
    total: number;
  };
  provisiones: {
    cesantias: number;
    interesesCesantias: number;
    prima: number;
    vacaciones: number;
    total: number;
  };
  netoPagar: number;
  costoEmpleador: number;
  baseRetencionUvt: number;
}

const round = (n: number) => Math.round(n);

/** Tarifa del FSP según el IBC expresado en SMMLV. */
function fspRate(ibcEnSmmlv: number, s: PayrollSettingsData): number {
  if (ibcEnSmmlv < 4) return 0;
  for (const t of s.fspTramos) {
    if (t.hastaSmmlv === null || ibcEnSmmlv <= t.hastaSmmlv) return t.rate;
  }
  return 0;
}

/** Retención en la fuente (art. 383) sobre una base en pesos → pesos. */
function retencion383(baseGravablePesos: number, s: PayrollSettingsData): number {
  if (baseGravablePesos <= 0) return 0;
  const baseUvt = baseGravablePesos / s.uvt;
  for (const t of s.tabla383) {
    const dentro = t.hastaUvt === null || baseUvt <= t.hastaUvt;
    if (dentro) {
      const uvt = (baseUvt - t.desdeUvt) * t.rate + t.uvtBase;
      return round(Math.max(0, uvt) * s.uvt);
    }
  }
  return 0;
}

/** Base gravable en UVT (solo para mostrar el tramo aplicado). */
function baseUvtDe(baseGravablePesos: number, s: PayrollSettingsData): number {
  return baseGravablePesos > 0
    ? Math.round((baseGravablePesos / s.uvt) * 100) / 100
    : 0;
}

/** Último tramo de una tabla `{desde}` vigente en `fecha` (o null). */
function tramoEn<T extends { desde: string }>(fecha: string, tramos: readonly T[]): T | null {
  let vigente: T | null = null;
  for (const t of tramos) {
    if (t.desde <= fecha && (!vigente || t.desde >= vigente.desde)) vigente = t;
  }
  return vigente;
}

/**
 * Pactos de la empresa sin las filas que son copia de la tabla legal. Los
 * expedientes guardados antes del ítem 1.8 traían la tabla legal mezclada con
 * los pactos; tomar el tramo más reciente de esa mezcla hacía que un pacto de
 * 40 h firmado en 2024 cediera ante el tramo legal de 42 h de 2026.
 */
function pactosDe(tramos: readonly JornadaTramo[] | undefined): JornadaTramo[] {
  return (tramos ?? []).filter(
    (t) =>
      !JORNADA_TRAMOS_LEY_2101.some(
        (l) => l.desde === t.desde && l.horasSemana === t.horasSemana,
      ),
  );
}

/**
 * Jornada semanal (horas) vigente en `fecha`: el menor entre el tramo legal
 * (Ley 2101 de 2021, art. 3; CST art. 161) y el pacto de la empresa vigente en
 * esa fecha. El pacto solo puede bajar la jornada, nunca subirla.
 */
export function jornadaSemanalVigente(
  fecha: string,
  s: Pick<PayrollSettingsData, 'jornadaTramos'>,
): number {
  const legal =
    tramoEn(fecha, JORNADA_TRAMOS_LEY_2101)?.horasSemana ?? JORNADA_MAXIMA_ANTERIOR;
  const pactada = tramoEn(fecha, pactosDe(s.jornadaTramos))?.horasSemana ?? null;
  return pactada !== null && pactada > 0 ? Math.min(legal, pactada) : legal;
}

/**
 * Horas mensuales que dividen el salario para hallar la hora ordinaria, según
 * la jornada vigente en `fecha` (YYYY-MM-DD): horas semanales / 6 días × 30
 * (Concepto MinTrabajo 08SI2023120300000016177 de 2023): 48→240, 47→235,
 * 46→230, 44→220, 42→210.
 */
export function horasMesVigentes(fecha: string, s: PayrollSettingsData): number {
  return (jornadaSemanalVigente(fecha, s) * DIAS_MES) / 6;
}

/**
 * Factores de recargo vigentes en `fecha`.
 *
 * - Dominical/festivo: el legal de la fecha (art. 179 CST, mod. Ley 2466 de
 *   2025, art. 14) o el pactado si es mayor. El valor del expediente no se lee:
 *   era una copia fija del 90 % que adelantaba el recargo a enero de 2026.
 * - Nocturno y extras: lo configurado, nunca por debajo del art. 168 CST.
 * - Los combinados suman el dominical vigente al nocturno o a la extra (el
 *   recargo dominical se acumula con los del art. 168).
 */
export function recargosVigentes(
  fecha: string,
  s: Pick<PayrollSettingsData, 'recargos' | 'recargoDominicalPactado'>,
): RecargoFactores {
  const legal =
    tramoEn(fecha, RECARGO_DOMINICAL_LEY_2466)?.factor ?? RECARGO_DOMINICAL_ANTERIOR;
  const dominical = Math.max(legal, s.recargoDominicalPactado ?? 0);
  const recargoNocturno = Math.max(
    RECARGOS_MINIMOS_ART_168.recargoNocturno,
    s.recargos.recargoNocturno,
  );
  const extraDiurna = Math.max(RECARGOS_MINIMOS_ART_168.extraDiurna, s.recargos.extraDiurna);
  const extraNocturna = Math.max(
    RECARGOS_MINIMOS_ART_168.extraNocturna,
    s.recargos.extraNocturna,
  );
  return {
    recargoNocturno,
    dominical,
    nocturnoDominical: recargoNocturno + dominical,
    extraDiurna,
    extraNocturna,
    extraDiurnaDominical: extraDiurna + dominical,
    extraNocturnaDominical: extraNocturna + dominical,
  };
}

/** Último día (YYYY-MM-DD) de un período mensual 'YYYY-MM'. */
export function fechaCorteDePeriodo(period: string): string {
  const y = Number(period.slice(0, 4));
  const mo = Number(period.slice(5, 7));
  const ultimo = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${period.slice(0, 7)}-${String(ultimo).padStart(2, '0')}`;
}

/** Hoy (YYYY-MM-DD) en Colombia: en UTC se elegiría mal la jornada a medianoche. */
function hoyColombia(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

const RECARGO_META: {
  key: keyof NovedadHoras;
  label: string;
  factorKey: keyof PayrollSettingsData['recargos'];
  esExtra: boolean;
}[] = [
  { key: 'recargoNocturno', label: 'Recargo nocturno', factorKey: 'recargoNocturno', esExtra: false },
  { key: 'dominical', label: 'Recargo dominical/festivo', factorKey: 'dominical', esExtra: false },
  { key: 'nocturnoDominical', label: 'Recargo nocturno dominical', factorKey: 'nocturnoDominical', esExtra: false },
  { key: 'extraDiurna', label: 'Hora extra diurna', factorKey: 'extraDiurna', esExtra: true },
  { key: 'extraNocturna', label: 'Hora extra nocturna', factorKey: 'extraNocturna', esExtra: true },
  { key: 'extraDiurnaDominical', label: 'Hora extra diurna dominical', factorKey: 'extraDiurnaDominical', esExtra: true },
  { key: 'extraNocturnaDominical', label: 'Hora extra nocturna dominical', factorKey: 'extraNocturnaDominical', esExtra: true },
];

/** Calcula el desprendible de nómina de un empleado en el período. */
export function computeSlip(
  input: PayrollInput,
  s: PayrollSettingsData,
): PayrollBreakdown {
  // `?? DIAS_MES` (no `|| DIAS_MES`): 0 días trabajados es un valor válido (no
  // se paga), y solo se cae al mes completo cuando el dato no viene (undefined).
  const dias = Math.max(0, Math.min(input.diasTrabajados ?? DIAS_MES, DIAS_MES));
  const factorDias = dias / DIAS_MES;
  const nov = input.novedades ?? {};
  const integral = input.salaryType === 'integral';

  const salario = round(input.salarioBase * factorDias);
  // El divisor sigue la jornada del período: con 240 fijo, desde la Ley 2101
  // la hora extra y los recargos quedaban cortos (12,5 % con 42 h).
  const fecha = input.fechaCorte ?? hoyColombia();
  const divisorHoras = horasMesVigentes(fecha, s);
  const horaOrdinaria = input.salarioBase / divisorHoras;
  const factores = recargosVigentes(fecha, s);

  // Recargos y horas extra.
  const recargoDetalle: RecargoLinea[] = [];
  let recargos = 0;
  let horasExtra = 0;
  // Trabajo en días de descanso: sale de la base de vacaciones (art. 192 CST).
  let recargosDescanso = 0;
  // El salario integral ya compensa de antemano los recargos nocturno,
  // dominical y festivo y el trabajo extraordinario (art. 132 num. 2 CST).
  const horas = integral ? {} : (nov.horas ?? {});
  for (const meta of RECARGO_META) {
    const h = horas[meta.key] ?? 0;
    if (h <= 0) continue;
    const factor = factores[meta.factorKey];
    // Extra = hora completa (1 + factor); recargo = solo el adicional.
    const mult = meta.esExtra ? 1 + factor : factor;
    const valor = round(h * horaOrdinaria * mult);
    recargoDetalle.push({ key: meta.key, label: meta.label, horas: h, factor, valor });
    if (meta.esExtra) horasExtra += valor;
    else recargos += valor;
    if (meta.key === 'dominical' || meta.key === 'nocturnoDominical') {
      recargosDescanso += valor;
    }
  }

  const bonificacionSalarial = round(nov.bonificacionSalarial ?? 0);
  const bonificacionNoSalarial = round(nov.bonificacionNoSalarial ?? 0);
  const comisiones = round(nov.comisiones ?? 0);

  // Auxilio de transporte: solo ordinario y salario base <= tope.
  const auxilioTransporte =
    !integral && input.salarioBase <= s.auxTransporteMaxSmmlv * s.smmlv
      ? round(s.auxilioTransporte * factorDias)
      : 0;

  // Ingreso constitutivo de salario (para IBC y prestaciones).
  const devengoSalarial =
    salario + recargos + horasExtra + bonificacionSalarial + comisiones;

  const totalDevengado =
    devengoSalarial + auxilioTransporte + bonificacionNoSalarial;

  // IBC.
  const ibcBase = integral ? salario * s.integralIbcFactor : devengoSalarial;
  const ibcMax = s.ibcMaxSmmlv * s.smmlv;
  const ibcMin = s.ibcMinSmmlv * s.smmlv * factorDias;
  const ibc = round(Math.min(Math.max(ibcBase, ibcMin), ibcMax));

  // Deducciones del trabajador.
  const salud = round(ibc * s.saludEmpleado);
  const pension = round(ibc * s.pensionEmpleado);
  const fsp = round(ibc * fspRate(ibc / s.smmlv, s));

  // Retención en la fuente (procedimiento 1).
  const aportesObligatorios = salud + pension + fsp;
  const ingresoNeto = totalDevengado - aportesObligatorios;
  const depDeduccion = nov.dependientes
    ? Math.min(0.1 * totalDevengado, s.depMaxUvt * s.uvt)
    : 0;
  const vivienda = Math.min(nov.deduccionVivienda ?? 0, s.viviendaMaxUvt * s.uvt);
  const prepagada = Math.min(
    nov.deduccionPrepagada ?? 0,
    s.prepagadaMaxUvt * s.uvt,
  );
  const deduccionesRenta = depDeduccion + vivienda + prepagada;
  const rentaExenta = Math.min(
    s.rentaExentaPorc * (ingresoNeto - deduccionesRenta),
    s.rentaExentaMaxUvtMes * s.uvt,
  );
  const beneficios = Math.min(
    deduccionesRenta + Math.max(0, rentaExenta),
    s.limiteGlobalPorc * ingresoNeto,
    s.limiteGlobalUvtMes * s.uvt,
  );
  const baseGravable = Math.max(0, ingresoNeto - beneficios);
  const retencionFuente = retencion383(baseGravable, s);
  const otras = round(nov.otrasDeducciones ?? 0);

  const totalDeducciones = salud + pension + fsp + retencionFuente + otras;
  const netoPagar = totalDevengado - totalDeducciones;

  // Aportes del empleador.
  const exonera =
    s.empresaExoneradaAportes &&
    !integral &&
    input.salarioBase < s.exoneracionSmmlv * s.smmlv;
  const arlRate = input.arlRiskLevel ? s.arlRates[input.arlRiskLevel] : 0;
  const apSalud = exonera ? 0 : round(ibc * s.saludEmpleador);
  const apPension = round(ibc * s.pensionEmpleador);
  const apArl = round(ibc * arlRate);
  const apCcf = round(ibc * s.ccf);
  const apSena = exonera ? 0 : round(ibc * s.sena);
  const apIcbf = exonera ? 0 : round(ibc * s.icbf);
  const aportesTotal = apSalud + apPension + apArl + apCcf + apSena + apIcbf;

  // Provisiones prestacionales.
  const baseCesPrima = integral ? 0 : devengoSalarial + auxilioTransporte;
  const cesantias = round(baseCesPrima * s.cesantias);
  const interesesCesantias = round(cesantias * s.interesesCesantias);
  const prima = round(baseCesPrima * s.prima);
  // Vacaciones sí aplican a integral; base sin auxilio de transporte y sin
  // extras ni trabajo en días de descanso obligatorio (art. 192 CST). Las
  // extras dominicales ya van dentro de `horasExtra`.
  const vacaciones = round(
    (devengoSalarial - horasExtra - recargosDescanso) * s.vacaciones,
  );
  const provisionesTotal = cesantias + interesesCesantias + prima + vacaciones;

  const costoEmpleador = totalDevengado + aportesTotal + provisionesTotal;

  return {
    diasTrabajados: dias,
    divisorHoras,
    horaOrdinaria: Math.round(horaOrdinaria),
    devengados: {
      salario,
      auxilioTransporte,
      recargos,
      horasExtra,
      recargoDetalle,
      bonificacionSalarial,
      bonificacionNoSalarial,
      comisiones,
      total: totalDevengado,
    },
    ibc,
    deducciones: {
      salud,
      pension,
      fsp,
      retencionFuente,
      otras,
      total: totalDeducciones,
    },
    aportesEmpleador: {
      salud: apSalud,
      pension: apPension,
      arl: apArl,
      ccf: apCcf,
      sena: apSena,
      icbf: apIcbf,
      total: aportesTotal,
    },
    provisiones: {
      cesantias,
      interesesCesantias,
      prima,
      vacaciones,
      total: provisionesTotal,
    },
    netoPagar,
    costoEmpleador,
    baseRetencionUvt: baseUvtDe(baseGravable, s),
  };
}
