/**
 * Liquidación definitiva de prestaciones al terminar el contrato (Colombia).
 * Calcula cesantías, intereses, prima y vacaciones proporcionales, más la
 * indemnización por despido sin justa causa (art. 64 CST). Función pura.
 * Es una estimación; casos especiales requieren revisión del contador/abogado.
 */
import { PayrollSettingsData } from './payroll.constants';
import { cop, redondearA } from '../../finance/domain/money.util';
import { SalaryType } from './payroll-calc';

export type MotivoRetiro =
  | 'renuncia'
  | 'justa_causa'
  | 'sin_justa_causa'
  | 'fin_contrato'
  | 'mutuo_acuerdo';

export interface LiquidacionInput {
  salarioBase: number;
  salaryType: SalaryType;
  fechaInicio: string; // YYYY-MM-DD (ingreso o última liquidación)
  fechaFin: string; // YYYY-MM-DD (retiro)
  contractType?: string;
  motivo: MotivoRetiro;
  salariosPendientes?: number;
  /** Días que faltaban para terminar el contrato (fijo / obra o labor). */
  diasFaltantesContrato?: number;
  /**
   * Desde cuándo se liquidan cesantías e intereses. Por defecto el mayor entre
   * el ingreso y el 1 de enero del año del retiro: las de años anteriores ya se
   * consignaron al fondo (Ley 50/1990 art. 99) y sus intereses se pagaron en
   * enero (Ley 52/1975). Se sobrescribe si quedó algo sin consignar.
   */
  inicioCesantias?: string;
  /** Días hábiles de vacaciones ya disfrutados (o compensados) en todo el contrato (CST arts. 186 y 189). */
  vacacionesDisfrutadasDias?: number;
  /**
   * Ingreso mensual promedio (pesos) de los últimos 6 meses: devengado total de
   * las colillas cerradas. Mide la exención de las cesantías (ET 206-4) y el
   * umbral de retención de la indemnización (ET 401-3). Sin él, el salario base.
   */
  ingresoMensualPromedio?: number;
}

export interface LiquidacionBreakdown {
  diasLiquidados: number;
  /** Días del semestre que paga la prima (nodo `Primas@Cantidad` de la nómina electrónica). */
  diasPrima?: number;
  /** Desde cuándo y cuántos días se liquidan cesantías e intereses. */
  inicioCesantias?: string;
  diasCesantias?: number;
  /** Días hábiles de vacaciones: causados en el contrato, ya disfrutados y pendientes (los que se pagan). */
  diasVacacionesCausados?: number;
  vacacionesDisfrutadasDias?: number;
  diasVacacionesPendientes?: number;
  salarioBase: number;
  auxilioTransporte: number;
  basePrestacional: number;
  cesantias: number;
  interesesCesantias: number;
  prima: number;
  vacaciones: number;
  indemnizacion: number;
  detalleIndemnizacion?: string;
  salariosPendientes: number;
  total: number;
  /** Ingreso mensual promedio con que se midieron la exención de cesantías y la retención (pesos). */
  ingresoMensualPromedio?: number;
  /** Parte exenta de cesantías e intereses (0 a 1, ET 206-4). No lleva retención (DUR 1625/2016 art. 1.2.4.1.11). */
  porcentajeExentoCesantias?: number;
  /**
   * Retención en la fuente de la liquidación: la de la indemnización (ET 401-3).
   * Ausente en liquidaciones guardadas antes de calcularla (tarea 14 del dueño).
   */
  retencionFuente?: number;
  detalleRetencion?: string;
  /** Lo que se le paga: `total` menos la retención. */
  netoPagar?: number;
}

/**
 * Exención de cesantías e intereses por ingreso mensual promedio de los últimos
 * 6 meses (ET art. 206 num. 4, texto vigente; valores en UVT, sin cambio para
 * 2026). Hasta 350 UVT es 100 % exento; desde 650 UVT, nada.
 * Fuente: Estatuto Tributario art. 206 num. 4 (Secretaría del Senado /
 * normograma DIAN), escala transcrita en gerencie.com «Cesantías exentas del
 * impuesto a la renta», consultado el 2026-11-06.
 */
export const TABLA_EXENCION_CESANTIAS_ET_206_4: { hastaUvt: number | null; exento: number }[] = [
  { hastaUvt: 350, exento: 1 },
  { hastaUvt: 410, exento: 0.9 },
  { hastaUvt: 470, exento: 0.8 },
  { hastaUvt: 530, exento: 0.6 },
  { hastaUvt: 590, exento: 0.4 },
  { hastaUvt: 650, exento: 0.2 },
  { hastaUvt: null, exento: 0 },
];

/**
 * Parte exenta (0 a 1) de cesantías e intereses según el ingreso mensual
 * promedio (pesos) y la UVT del año (ET 206-4). Cada tramo incluye su tope:
 * «mayor de 350 y hasta 410 UVT» es 90 %.
 */
export function porcentajeExentoCesantias(ingresoMensualPromedio: number, uvt: number): number {
  if (!(uvt > 0)) return 1;
  const enUvt = ingresoMensualPromedio / uvt;
  for (const t of TABLA_EXENCION_CESANTIAS_ET_206_4) {
    if (t.hastaUvt === null || enUvt <= t.hastaUvt) return t.exento;
  }
  return 0;
}

/**
 * Retención sobre indemnizaciones laborales: 20 % (ET art. 401-3, adicionado
 * por la Ley 488/1998 art. 27) para trabajadores con ingresos mensuales
 * superiores a 204 UVT (DUR 1625/2016 art. 1.2.4.1.13, del Decreto 379/2007,
 * que reexpresó en UVT los 10 SMMLV de la ley). Con 204 UVT o menos, no hay
 * retención por este concepto. Fuente: normograma del DUR 1625/2016 (cancilleria.gov.co,
 * decreto_1625_2016_pr011), consultado el 2026-11-06.
 */
export const RETENCION_INDEMNIZACION_TARIFA_ET_401_3 = 0.2;
export const RETENCION_INDEMNIZACION_UMBRAL_UVT_DUR_1_2_4_1_13 = 204;

/**
 * Retención de la indemnización (ET 401-3). El 25 % es renta exenta (ET 206
 * num. 10) porque la indemnización es un pago laboral (Oficio DIAN 024563 del
 * 26-sep-2019); se topa con el límite mensual de esa renta exenta (790 UVT al
 * año, Ley 2277/2022) por prudencia: el agente retenedor responde por lo que
 * deje de retener. Se practica aparte de la retención del salario del mes.
 */
export function retencionIndemnizacion(
  indemnizacion: number,
  ingresoMensual: number,
  s: Pick<PayrollSettingsData, 'uvt' | 'rentaExentaPorc' | 'rentaExentaMaxUvtMes'>,
): { retencion: number; exenta: number; base: number } {
  if (indemnizacion <= 0 || !(s.uvt > 0) || ingresoMensual <= RETENCION_INDEMNIZACION_UMBRAL_UVT_DUR_1_2_4_1_13 * s.uvt) {
    return { retencion: 0, exenta: 0, base: 0 };
  }
  const exenta = cop(Math.min(indemnizacion * s.rentaExentaPorc, s.rentaExentaMaxUvtMes * s.uvt));
  const base = indemnizacion - exenta;
  return { retencion: cop(base * RETENCION_INDEMNIZACION_TARIFA_ET_401_3), exenta, base };
}

const round = cop;

/** ¿Es `f` (YYYY-MM-DD) el último día de su mes? */
function esFinDeMes(f: string): boolean {
  const [y, m, d] = f.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, m ?? 1, 0)).getUTCDate() === d;
}

/**
 * Días laborados entre dos fechas, CONTANDO AMBAS, por el método comercial
 * 360: del 1 de enero al 20 de octubre son 290 y un año completo (1-ene a
 * 31-dic) son 360. El último día de cualquier mes cuenta como 30 (también
 * febrero). Es la cuenta de la liquidación de retiro.
 */
export function dias360Inclusivo(from: string, to: string): number {
  if (to < from) return 0;
  const [y1, m1, dd1] = from.split('-').map(Number);
  const [y2, m2, dd2] = to.split('-').map(Number);
  const d1 = Math.min(dd1 ?? 1, 30);
  const d2 = esFinDeMes(to) ? 30 : Math.min(dd2 ?? 1, 30);
  return Math.max(0, ((y2 ?? 0) - (y1 ?? 0)) * 360 + ((m2 ?? 0) - (m1 ?? 0)) * 30 + (d2 - d1) + 1);
}

/**
 * Días que la nómina del mes del retiro puede pagar: del mayor entre el
 * ingreso y el día 1 del mes, hasta el retiro, ambos incluidos (360). La usan
 * el aviso al aprobar la liquidación y el bloqueo del consolidador, para que
 * las dos comparen igual.
 */
export function diasPagablesHastaRetiro(hireDate: string | undefined, fechaRetiro: string): number {
  const primero = `${fechaRetiro.slice(0, 7)}-01`;
  const desde = hireDate && hireDate > primero ? hireDate : primero;
  return fechaRetiro >= desde ? dias360Inclusivo(desde, fechaRetiro) : 0;
}

/** Días entre dos fechas por el método comercial 360 (meses de 30 días), sin contar el último. */
export function dias360(from: string, to: string): number {
  const [y1, m1, dd1] = from.split('-').map(Number);
  const [y2, m2, dd2] = to.split('-').map(Number);
  let d1 = dd1 ?? 1;
  let d2 = dd2 ?? 1;
  if (d1 === 31) d1 = 30;
  if (d2 === 31) d2 = 30;
  const dias =
    ((y2 ?? 0) - (y1 ?? 0)) * 360 +
    ((m2 ?? 0) - (m1 ?? 0)) * 30 +
    (d2 - d1);
  return Math.max(0, dias);
}

export function computeLiquidacion(
  input: LiquidacionInput,
  s: PayrollSettingsData,
): LiquidacionBreakdown {
  const integral = input.salaryType === 'integral';
  const salarioBase = input.salarioBase;
  const salarioDiario = salarioBase / 30;

  const auxilioTransporte =
    !integral && salarioBase <= s.auxTransporteMaxSmmlv * s.smmlv
      ? s.auxilioTransporte
      : 0;
  const basePrestacional = salarioBase + auxilioTransporte;

  const dias = dias360Inclusivo(input.fechaInicio, input.fechaFin);

  // Cesantías e intereses: solo las del año del retiro (las anteriores ya se
  // consignaron al fondo). El salario integral ya los incorpora.
  const anioRetiro = `${input.fechaFin.slice(0, 4)}-01-01`;
  const inicioCesantias =
    input.inicioCesantias ?? (input.fechaInicio > anioRetiro ? input.fechaInicio : anioRetiro);
  const diasCesantias = dias360Inclusivo(inicioCesantias, input.fechaFin);
  const cesantias = integral ? 0 : round((basePrestacional * diasCesantias) / 360);
  const interesesCesantias = integral
    ? 0
    : round((cesantias * diasCesantias * 0.12) / 360);

  // Prima proporcional del semestre en curso al momento del retiro.
  const [y, m] = input.fechaFin.split('-').map(Number);
  const semestreInicio = (m ?? 1) <= 6 ? `${y}-01-01` : `${y}-07-01`;
  const inicioPrima =
    input.fechaInicio > semestreInicio ? input.fechaInicio : semestreInicio;
  const diasPrima = dias360Inclusivo(inicioPrima, input.fechaFin);
  const prima = integral ? 0 : round((basePrestacional * diasPrima) / 360);

  // Vacaciones: 15 días hábiles por año de servicio (art. 186 CST), menos los
  // ya disfrutados; se pagan los pendientes (art. 189), sin auxilio. Las
  // compensadas al retiro no son base de salud ni pensión: la compensación en dinero no es salario
  // (CST art. 189) y la cotización «durante vacaciones» es la de las disfrutadas (Decreto 806/1998 art. 70,
  // Decreto 1406/1999 art. 40). Así lo planteó la propia UGPP en el exp. 27226 del Consejo de Estado
  // (Sección 4.ª, 11-may-2023), que además fijó que SÍ son base de parafiscales SENA/ICBF/CCF (Ley 21/1982
  // art. 17). Verificado el 2026-11-06 (tarea 14 del dueño, punto 2).
  const diasVacacionesCausados = redondearA((dias * 15) / 360, 2);
  const disfrutadas = Math.max(0, input.vacacionesDisfrutadasDias ?? 0);
  // El pago sale de los días exactos; los redondeados a 2 decimales son para mostrar y reportar.
  const pendientesExactos = Math.max(0, (dias * 15) / 360 - disfrutadas);
  const diasVacacionesPendientes = redondearA(pendientesExactos, 2);
  const vacaciones = round((salarioBase * pendientesExactos) / 30);

  // Indemnización por despido sin justa causa (art. 64 CST).
  let indemnizacion = 0;
  let detalleIndemnizacion: string | undefined;
  if (input.motivo === 'sin_justa_causa') {
    const tipo = input.contractType ?? 'indefinido';
    if (tipo === 'fijo' || tipo === 'obra_labor') {
      const pedidos = Math.max(input.diasFaltantesContrato ?? 0, 0);
      // Obra o labor: el tiempo que faltaba para terminarla, nunca menos de 15 días (art. 64 CST).
      const faltantes = tipo === 'obra_labor' ? Math.max(pedidos, 15) : pedidos;
      indemnizacion = round(salarioDiario * faltantes);
      detalleIndemnizacion = `${tipo === 'fijo' ? 'Término fijo' : 'Obra o labor'}: ${faltantes} días${tipo === 'obra_labor' && faltantes > pedidos ? ' (mínimo legal)' : ' faltantes'}`;
    } else {
      // Indefinido.
      const anios = dias / 360;
      const menor10 = salarioBase < s.exoneracionSmmlv * s.smmlv;
      const primer = menor10 ? 30 : 20;
      const adicional = menor10 ? 20 : 15;
      const diasIndem =
        anios <= 1 ? primer : primer + adicional * (anios - 1);
      indemnizacion = round(salarioDiario * diasIndem);
      detalleIndemnizacion = `Indefinido (${menor10 ? '<' : '≥'} 10 SMMLV): ${
        redondearA(diasIndem, 1)
      } días`;
    }
  }

  const salariosPendientes = round(input.salariosPendientes ?? 0);
  const total =
    cesantias +
    interesesCesantias +
    prima +
    vacaciones +
    indemnizacion +
    salariosPendientes;

  // Retención (tarea 14 del dueño, punto 1). Cesantías e intereses: NUNCA llevan retención
  // (DUR 1625/2016 art. 1.2.4.1.11); su parte no exenta la declara el trabajador. Indemnización: 20 %.
  const ingresoMensual =
    input.ingresoMensualPromedio && input.ingresoMensualPromedio > 0 ? cop(input.ingresoMensualPromedio) : salarioBase;
  const pctExento = porcentajeExentoCesantias(ingresoMensual, s.uvt);
  const ret = retencionIndemnizacion(indemnizacion, ingresoMensual, s);
  const detalleRetencion =
    indemnizacion > 0
      ? ret.retencion > 0
        ? `Indemnización: 20 % sobre ${ret.base} (25 % exento: ${ret.exenta}), ingreso mensual > 204 UVT (art. 401-3 ET)`
        : 'Indemnización sin retención: ingreso mensual de 204 UVT o menos (art. 401-3 ET)'
      : undefined;

  return {
    diasLiquidados: dias,
    diasPrima,
    inicioCesantias,
    diasCesantias,
    diasVacacionesCausados,
    ...(input.vacacionesDisfrutadasDias !== undefined ? { vacacionesDisfrutadasDias: disfrutadas } : {}),
    diasVacacionesPendientes,
    salarioBase,
    auxilioTransporte,
    basePrestacional,
    cesantias,
    interesesCesantias,
    prima,
    vacaciones,
    indemnizacion,
    detalleIndemnizacion,
    salariosPendientes,
    total,
    ingresoMensualPromedio: ingresoMensual,
    porcentajeExentoCesantias: pctExento,
    retencionFuente: ret.retencion,
    ...(detalleRetencion ? { detalleRetencion } : {}),
    netoPagar: total - ret.retencion,
  };
}
