/**
 * Primera quincena (días 1 a 15) del pago mensual.
 *
 * Reglas (revisión contable, 20-nov-2026):
 * - Se paga el básico de los días de la quincena y el auxilio de transporte de
 *   esos días, menos salud y pensión de esos días: las cotizaciones se
 *   descuentan al momento de cada pago (Ley 100 de 1993, art. 22).
 * - Con las horas extra y los recargos de los turnos del 1 al 15 (decisión de
 *   Paulo, 20-nov-2026): se pagan en la quincena en que se trabajaron, que es
 *   lo que pide el art. 134 num. 2 CST (a más tardar con el período siguiente).
 *   Salud y pensión también se descuentan sobre ellos: son salario (art. 127).
 *   La clasificación va en orden cronológico, así que las horas del 1 al 15
 *   salen iguales a como las clasifica el cierre del mes.
 * - Sin retención en la fuente: es mensual y se calcula una sola vez al cierre
 *   sobre el total del mes (art. 383 ET).
 * - Se restan los días antes del ingreso y los de vacaciones, incapacidades o
 *   licencias ya registradas: el cierre los paga por su propia regla.
 * - Quien se retira el 15 o antes no recibe quincena: va en su liquidación.
 * - Nunca más de la mitad del neto estimado del mes, para que el segundo pago
 *   alcance a cubrir la retención y los descuentos del cierre.
 */
import { cop } from '../../finance/domain/money.util';
import type { PayrollSettingsData } from './payroll.constants';
import { computeSlip, type ArlLevel, type NovedadHoras, type SalaryType } from './payroll-calc';

export const DIA_CORTE_QUINCENA = 15;

export interface AusenciaDias {
  fechaInicio: string;
  fechaFin: string;
}

/** Día del mes (1–31) de una fecha YYYY-MM-DD. */
function diaDe(fecha: string): number {
  return Number(fecha.slice(8, 10));
}

/** Días de la primera quincena que se le pagan a un trabajador, y por qué no si son 0. */
export function diasPrimeraQuincena(
  period: string,
  emp: { hireDate?: string; terminationDate?: string },
  ausencias: AusenciaDias[],
): { dias: number; ausentes: number; motivo?: string } {
  const desde = `${period}-01`;
  const corte = `${period}-${String(DIA_CORTE_QUINCENA).padStart(2, '0')}`;
  if (emp.terminationDate && emp.terminationDate <= corte) {
    return { dias: 0, ausentes: 0, motivo: 'Se retira el 15 o antes: se le paga en su liquidación.' };
  }
  if (emp.hireDate && emp.hireDate > corte) {
    return { dias: 0, ausentes: 0, motivo: 'Entró después del 15: todo se le paga al cierre del mes.' };
  }
  const inicio = emp.hireDate && emp.hireDate > desde ? emp.hireDate : desde;
  // Días de ausencia dentro de [inicio, corte], sin contar dos veces un día.
  const fuera = new Set<number>();
  for (const a of ausencias) {
    const a0 = a.fechaInicio > inicio ? a.fechaInicio : inicio;
    const a1 = a.fechaFin < corte ? a.fechaFin : corte;
    if (a0 > a1) continue;
    for (let d = diaDe(a0); d <= diaDe(a1); d++) fuera.add(d);
  }
  const dias = diaDe(corte) - diaDe(inicio) + 1 - fuera.size;
  if (dias <= 0) {
    return { dias: 0, ausentes: fuera.size, motivo: 'Estuvo de vacaciones, incapacitado o de licencia toda la quincena.' };
  }
  return { dias, ausentes: fuera.size };
}

export interface CalculoQuincena {
  sueldo: number;
  auxilioTransporte: number;
  /** Recargos nocturnos y dominicales de los turnos del 1 al 15. */
  recargos: number;
  /** Horas extra de los turnos del 1 al 15. */
  horasExtra: number;
  salud: number;
  pension: number;
  fsp: number;
  /** Lo que se le entrega. */
  neto: number;
  /** Mitad del neto estimado del mes: lo máximo que puede recibir en la quincena. */
  tope: number;
  /** Retención estimada del mes, si la hay: se descuenta toda al cierre. */
  retencionEstimadaMes: number;
}

/** Valores de la primera quincena con las mismas reglas de la colilla mensual. */
export function calcularPrimeraQuincena(
  emp: { salario: number; salaryType: SalaryType; arlRiskLevel?: ArlLevel },
  dias: number,
  s: PayrollSettingsData,
  fechaCorte: string,
  horas?: NovedadHoras,
): CalculoQuincena {
  const base = {
    salarioBase: emp.salario,
    salaryType: emp.salaryType,
    arlRiskLevel: emp.arlRiskLevel,
    fechaCorte,
    // El integral ya compensa recargos y extras (art. 132 num. 2 CST).
    ...(horas && emp.salaryType !== 'integral' ? { novedades: { horas } } : {}),
  };
  const q = computeSlip({ ...base, diasTrabajados: dias }, s);
  // El mes estimado lleva las mismas horas: ya están trabajadas.
  const mes = computeSlip({ ...base, diasTrabajados: 30 }, s);
  const sueldo = q.devengados.salario;
  const auxilioTransporte = q.devengados.auxilioTransporte;
  const recargos = q.devengados.recargos;
  const horasExtra = q.devengados.horasExtra;
  const salud = q.deducciones.salud;
  const pension = q.deducciones.pension;
  const fsp = q.deducciones.fsp;
  const netoMes =
    mes.devengados.total -
    mes.deducciones.salud -
    mes.deducciones.pension -
    mes.deducciones.fsp -
    mes.deducciones.retencionFuente;
  // Medio peso arriba o abajo no cambia nada: la segunda quincena cubre el resto.
  const tope = Math.max(0, cop(netoMes / 2));
  const neto = Math.max(
    0,
    Math.min(cop(sueldo + auxilioTransporte + recargos + horasExtra - salud - pension - fsp), tope),
  );
  return {
    sueldo,
    auxilioTransporte,
    recargos,
    horasExtra,
    salud,
    pension,
    fsp,
    neto,
    tope,
    retencionEstimadaMes: mes.deducciones.retencionFuente,
  };
}
