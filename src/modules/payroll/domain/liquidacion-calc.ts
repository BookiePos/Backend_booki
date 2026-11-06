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
  // compensadas al retiro no son base de salud ni pensión (art. 192 CST; las
  // disfrutadas sí, Decreto 1406/1999 art. 40): a confirmar con concepto UGPP vigente.
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
  };
}
