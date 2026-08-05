/**
 * Motor de cálculo de nómina mensual (Colombia). Funciones puras: reciben los
 * datos del empleado + novedades del período y los parámetros vigentes, y
 * devuelven el desprendible completo (devengados, deducciones, aportes del
 * empleador y provisiones prestacionales). Nada de acceso a BD aquí.
 */
import {
  DIAS_MES,
  HORAS_MES,
  PayrollSettingsData,
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
  const horaOrdinaria = input.salarioBase / HORAS_MES;

  // Recargos y horas extra.
  const recargoDetalle: RecargoLinea[] = [];
  let recargos = 0;
  let horasExtra = 0;
  const horas = nov.horas ?? {};
  for (const meta of RECARGO_META) {
    const h = horas[meta.key] ?? 0;
    if (h <= 0) continue;
    const factor = s.recargos[meta.factorKey];
    // Extra = hora completa (1 + factor); recargo = solo el adicional.
    const mult = meta.esExtra ? 1 + factor : factor;
    const valor = round(h * horaOrdinaria * mult);
    recargoDetalle.push({ key: meta.key, label: meta.label, horas: h, factor, valor });
    if (meta.esExtra) horasExtra += valor;
    else recargos += valor;
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
  // Vacaciones sí aplican a integral; base sin auxilio de transporte.
  const vacaciones = round(devengoSalarial * s.vacaciones);
  const provisionesTotal = cesantias + interesesCesantias + prima + vacaciones;

  const costoEmpleador = totalDevengado + aportesTotal + provisionesTotal;

  return {
    diasTrabajados: dias,
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
