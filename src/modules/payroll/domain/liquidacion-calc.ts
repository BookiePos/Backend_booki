/**
 * Liquidación definitiva de prestaciones al terminar el contrato (Colombia).
 * Calcula cesantías, intereses, prima y vacaciones proporcionales, más la
 * indemnización por despido sin justa causa (art. 64 CST). Función pura.
 * Es una estimación; casos especiales requieren revisión del contador/abogado.
 */
import { PayrollSettingsData } from './payroll.constants';
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
}

export interface LiquidacionBreakdown {
  diasLiquidados: number;
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

const round = (n: number) => Math.round(n);

/** Días entre dos fechas por el método comercial 360 (meses de 30 días). */
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

  const dias = dias360(input.fechaInicio, input.fechaFin);

  // Cesantías, intereses y prima: el salario integral ya los incorpora.
  const cesantias = integral ? 0 : round((basePrestacional * dias) / 360);
  const interesesCesantias = integral
    ? 0
    : round((cesantias * dias * 0.12) / 360);

  // Prima proporcional del semestre en curso al momento del retiro.
  const [y, m] = input.fechaFin.split('-').map(Number);
  const semestreInicio = (m ?? 1) <= 6 ? `${y}-01-01` : `${y}-07-01`;
  const inicioPrima =
    input.fechaInicio > semestreInicio ? input.fechaInicio : semestreInicio;
  const diasPrima = dias360(inicioPrima, input.fechaFin);
  const prima = integral ? 0 : round((basePrestacional * diasPrima) / 360);

  // Vacaciones proporcionales (base sin auxilio de transporte).
  const vacaciones = round((salarioBase * dias) / 720);

  // Indemnización por despido sin justa causa (art. 64 CST).
  let indemnizacion = 0;
  let detalleIndemnizacion: string | undefined;
  if (input.motivo === 'sin_justa_causa') {
    const tipo = input.contractType ?? 'indefinido';
    if (tipo === 'fijo' || tipo === 'obra_labor') {
      const faltantes = Math.max(input.diasFaltantesContrato ?? 0, 0);
      indemnizacion = round(salarioDiario * faltantes);
      detalleIndemnizacion = `${tipo === 'fijo' ? 'Término fijo' : 'Obra o labor'}: ${faltantes} días faltantes`;
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
        Math.round(diasIndem * 10) / 10
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
