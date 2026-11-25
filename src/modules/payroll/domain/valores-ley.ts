/**
 * Valores que fija el Gobierno cada año para la nómina, por año calendario.
 *
 * Sirven para dos cosas: comparar lo que la empresa tiene en uso con lo que
 * dice la norma (y avisar si difieren) y ofrecer «volver a los de ley». El
 * cálculo NO lee esta tabla: lee los parámetros con vigencia de core-params,
 * que se siembran con los del año en curso. Así un decreto que llega tarde se
 * carga como una vigencia nueva sin tocar código, y esta tabla solo se
 * actualiza cuando sale el decreto del año siguiente.
 */
import {
  FRANJA_NOCTURNA_LEY_2466,
  JORNADA_TRAMOS_LEY_2101,
  NOCTURNO_DESDE_HORA_ANTERIOR,
  NOCTURNO_HASTA_HORA,
  PayrollSettingsData,
  RECARGO_DOMINICAL_ANTERIOR,
  RECARGO_DOMINICAL_LEY_2466,
  RECARGOS_MINIMOS_ART_168,
  RecargoFactores,
} from './payroll.constants';
import { redondearA } from '../../finance/domain/money.util';
import {
  horasMesVigentes,
  jornadaSemanalVigente,
  recargosVigentes,
} from './payroll-calc';

export interface ValoresLeyAno {
  year: number;
  /** Salario mínimo mensual legal vigente, en pesos. */
  smmlv: number;
  /** Auxilio de transporte mensual, en pesos. */
  auxilioTransporte: number;
  /** Unidad de valor tributario, en pesos. */
  uvt: number;
  fuentes: {
    smmlv: string;
    auxilioTransporte: string;
    uvt: string;
  };
}

export const VALORES_LEY_POR_ANO: Readonly<Record<number, ValoresLeyAno>> = {
  2025: {
    year: 2025,
    smmlv: 1_423_500,
    auxilioTransporte: 200_000,
    uvt: 49_799,
    fuentes: {
      smmlv: 'Decreto 1572 de 2024',
      auxilioTransporte: 'Decreto 1573 de 2024',
      uvt: 'Resolución DIAN 000193 de 2024',
    },
  },
  2026: {
    year: 2026,
    smmlv: 1_750_905,
    auxilioTransporte: 249_095,
    uvt: 52_374,
    fuentes: {
      smmlv: 'Decreto 1469 de 2025',
      auxilioTransporte: 'Decreto 1470 de 2025',
      uvt: 'Resolución DIAN 000238 de 2025',
    },
  },
};

/** Valores de ley de un año, o `null` si aún no están cargados en BookiPos. */
export function valoresLeyDe(year: number): ValoresLeyAno | null {
  return VALORES_LEY_POR_ANO[year] ?? null;
}

/** Un cambio que la ley ya tiene programado para una fecha futura. */
export interface CambioProgramado {
  concepto: string;
  /** Texto del valor nuevo, listo para mostrar ("100 %", "42 horas"). */
  valor: string;
  /** YYYY-MM-DD desde el que rige. */
  desde: string;
  fuente: string;
}

/** Lo que la pantalla «Valores de ley» muestra: lo que de verdad usa el cálculo. */
export interface ValoresLeyVista {
  /** Fecha (YYYY-MM-DD) a la que se leyeron los valores. */
  fecha: string;
  year: number;
  /** Los de la norma para ese año, o `null` si BookiPos aún no los tiene. */
  ley: ValoresLeyAno | null;
  enUso: {
    smmlv: number;
    auxilioTransporte: number;
    uvt: number;
    /** Hasta cuántos salarios mínimos se paga auxilio de transporte. */
    auxTransporteMaxSmmlv: number;
    jornadaSemanal: number;
    /** Horas del mes con las que se divide el sueldo para hallar la hora. */
    horasMes: number;
    nocturnoDesdeHora: number;
    nocturnoHastaHora: number;
    /** Recargos que aplica el cálculo en esa fecha (factores: 0.35 = 35 %). */
    recargos: RecargoFactores;
    recargoDominicalLegal: number;
    recargosMinimos: { recargoNocturno: number; extraDiurna: number; extraNocturna: number };
    saludEmpleado: number;
    saludEmpleador: number;
    pensionEmpleado: number;
    pensionEmpleador: number;
    ccf: number;
    sena: number;
    icbf: number;
    arlRates: PayrollSettingsData['arlRates'];
    cesantias: number;
    interesesCesantias: number;
    prima: number;
    vacaciones: number;
    fspTramos: PayrollSettingsData['fspTramos'];
    tabla383: PayrollSettingsData['tabla383'];
    ibcMaxSmmlv: number;
    integralSmmlv: number;
    exoneracionSmmlv: number;
    empresaExoneradaAportes: boolean;
    exoneracionConfirmada: boolean;
    diasLaborablesSemana: number;
  };
  /** Claves de `enUso` que no coinciden con la norma del año. */
  distintosDeLey: ('smmlv' | 'auxilioTransporte' | 'uvt')[];
  /** Cambios que la ley ya tiene fechados después de `fecha`. */
  programados: CambioProgramado[];
}

function siguiente<T extends { desde: string }>(fecha: string, tramos: readonly T[]): T | null {
  return [...tramos].sort((a, b) => a.desde.localeCompare(b.desde)).find((t) => t.desde > fecha) ?? null;
}

const pct = (f: number): string => `${redondearA(f * 100, 1)} %`.replace('.', ',');

/**
 * Arma la vista de los valores de ley a partir de los parámetros YA resueltos
 * en `fecha` (`PayrollService.parametrosEn`), con las mismas funciones que usa
 * el cálculo: lo que se ve aquí es exactamente lo que se liquida.
 */
export function armarValoresLey(fecha: string, s: PayrollSettingsData): ValoresLeyVista {
  const year = Number(fecha.slice(0, 4));
  const ley = valoresLeyDe(year);
  let nocturnoDesdeHora = NOCTURNO_DESDE_HORA_ANTERIOR;
  for (const t of FRANJA_NOCTURNA_LEY_2466) if (t.desde <= fecha) nocturnoDesdeHora = t.desdeHora;
  let dominicalLegal = RECARGO_DOMINICAL_ANTERIOR;
  for (const t of RECARGO_DOMINICAL_LEY_2466) if (t.desde <= fecha) dominicalLegal = t.factor;

  const programados: CambioProgramado[] = [];
  const dom = siguiente(fecha, RECARGO_DOMINICAL_LEY_2466);
  if (dom) {
    programados.push({
      concepto: 'Recargo por trabajar domingo o festivo',
      valor: pct(dom.factor),
      desde: dom.desde,
      fuente: 'Ley 2466 de 2025, art. 14',
    });
  }
  const jor = siguiente(fecha, JORNADA_TRAMOS_LEY_2101);
  if (jor) {
    programados.push({
      concepto: 'Jornada máxima semanal',
      valor: `${jor.horasSemana} horas`,
      desde: jor.desde,
      fuente: 'Ley 2101 de 2021, art. 3',
    });
  }
  const noc = siguiente(fecha, FRANJA_NOCTURNA_LEY_2466);
  if (noc) {
    programados.push({
      concepto: 'Inicio del horario nocturno',
      valor: `${noc.desdeHora}:00`,
      desde: noc.desde,
      fuente: 'Ley 2466 de 2025, art. 10',
    });
  }

  const distintosDeLey: ValoresLeyVista['distintosDeLey'] = [];
  if (ley) {
    if (s.smmlv !== ley.smmlv) distintosDeLey.push('smmlv');
    if (s.auxilioTransporte !== ley.auxilioTransporte) distintosDeLey.push('auxilioTransporte');
    if (s.uvt !== ley.uvt) distintosDeLey.push('uvt');
  }

  return {
    fecha,
    year,
    ley,
    enUso: {
      smmlv: s.smmlv,
      auxilioTransporte: s.auxilioTransporte,
      uvt: s.uvt,
      auxTransporteMaxSmmlv: s.auxTransporteMaxSmmlv,
      jornadaSemanal: jornadaSemanalVigente(fecha, s),
      horasMes: horasMesVigentes(fecha, s),
      nocturnoDesdeHora,
      nocturnoHastaHora: NOCTURNO_HASTA_HORA,
      recargos: recargosVigentes(fecha, s),
      recargoDominicalLegal: dominicalLegal,
      recargosMinimos: { ...RECARGOS_MINIMOS_ART_168 },
      saludEmpleado: s.saludEmpleado,
      saludEmpleador: s.saludEmpleador,
      pensionEmpleado: s.pensionEmpleado,
      pensionEmpleador: s.pensionEmpleador,
      ccf: s.ccf,
      sena: s.sena,
      icbf: s.icbf,
      arlRates: s.arlRates,
      cesantias: s.cesantias,
      interesesCesantias: s.interesesCesantias,
      prima: s.prima,
      vacaciones: s.vacaciones,
      fspTramos: s.fspTramos,
      tabla383: s.tabla383,
      ibcMaxSmmlv: s.ibcMaxSmmlv,
      integralSmmlv: s.integralSmmlv,
      exoneracionSmmlv: s.exoneracionSmmlv,
      empresaExoneradaAportes: s.empresaExoneradaAportes,
      exoneracionConfirmada: s.exoneracionConfirmada === true,
      diasLaborablesSemana: s.diasLaborablesSemana ?? 6,
    },
    distintosDeLey,
    programados,
  };
}
