import { holidaysOfYear } from './colombia-holidays';

/** Días del mes comercial de nómina: todo mes cuenta 30 (y cada quincena 15). */
const DIAS_MES_COMERCIAL = 30;

/**
 * Días de descanso remunerado del período (ítem 1.19), que se suman a los días
 * con turno para liquidar el salario:
 *
 * - Domingo (CST arts. 172 y 173): se paga si el trabajador laboró todos los
 *   días laborables de esa semana. Los festivos de la semana no se exigen.
 * - Día no laborable de la semana pactada (el sábado con semana de 5 días,
 *   art. 164): la jornada de 5 días redistribuye las horas del sábado, no
 *   lo descuenta. Se paga con la misma condición que el domingo.
 * - Festivo entre semana (art. 177): es descanso remunerado. Se paga si el
 *   trabajador no lo laboró y trabajó algún día de esa semana (sin ninguno,
 *   no hay relación activa que remunerar en esa semana).
 *
 * Un día de descanso trabajado no se cuenta aquí: ya es un día trabajado, con
 * su recargo dominical. `trabajados` debe traer también los días de la semana
 * que empezó en el período anterior, para decidir el primer domingo.
 */
export function diasDescansoRemunerado(
  trabajados: ReadonlySet<string>,
  desde: string,
  hasta: string,
  diasLaborablesSemana: number,
): number {
  let pagados = 0;
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) {
    if (!trabajados.has(d) && esDescansoPagado(d, trabajados, diasLaborablesSemana)) {
      pagados++;
    }
  }
  return pagados;
}

/**
 * Días a liquidar del período sobre el mes comercial de 30 días (y quincenas
 * de 15): cada día del calendario que se trabajó o es descanso remunerado
 * cuenta 1, y el que no (ausencia no justificada, o antes del ingreso o
 * después del retiro) no cuenta.
 *
 * - El día 31 no se paga ni se descuenta: el mes comercial termina el 30.
 * - En febrero, los días que faltan hasta el 30 (2, o 1 si es bisiesto) siguen
 *   la suerte del último día del mes: si se pagó, se pagan. Así el mes
 *   trabajado completo da 30 y una ausencia da 29, y quien se retiró antes del
 *   28 no cobra días que no existieron.
 *
 * `desde`/`hasta` son un mes ('YYYY-MM-01' a su último día) o una quincena
 * (1 a 15, 16 al último día); la suma de las dos quincenas es el mes.
 */
export function diasALiquidar(
  trabajados: ReadonlySet<string>,
  desde: string,
  hasta: string,
  diasLaborablesSemana: number,
): number {
  const pagado = (d: string) =>
    trabajados.has(d) || esDescansoPagado(d, trabajados, diasLaborablesSemana);
  let dias = 0;
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) {
    if (diaDelMes(d) > DIAS_MES_COMERCIAL) continue;
    if (pagado(d)) dias++;
  }
  const ultimo = diaDelMes(hasta);
  if (esFinDeMes(hasta) && ultimo < DIAS_MES_COMERCIAL && pagado(hasta)) {
    dias += DIAS_MES_COMERCIAL - ultimo;
  }
  return Math.min(dias, diasComerciales(desde, hasta));
}

/** Largo comercial del rango: días del 1 al 30, cerrando el fin de mes en 30. */
function diasComerciales(desde: string, hasta: string): number {
  const fin = esFinDeMes(hasta) ? DIAS_MES_COMERCIAL : Math.min(diaDelMes(hasta), DIAS_MES_COMERCIAL);
  return Math.max(0, fin - diaDelMes(desde) + 1);
}

/** ¿Es `d` (no trabajado) un día de descanso que se remunera? */
function esDescansoPagado(
  d: string,
  trabajados: ReadonlySet<string>,
  diasLaborablesSemana: number,
): boolean {
  const dow = diaDeSemana(d); // 0 = lunes … 6 = domingo
  const lunes = sumarDias(d, -dow);
  const laborables = Array.from({ length: diasLaborablesSemana }, (_, i) =>
    sumarDias(lunes, i),
  );
  // Domingo y días no laborables de la semana pactada: semana cumplida.
  if (dow === 6 || dow >= diasLaborablesSemana) {
    const exigidos = laborables.filter((x) => !esFestivo(x));
    return exigidos.length > 0 && exigidos.every((x) => trabajados.has(x));
  }
  if (esFestivo(d)) return laborables.some((x) => trabajados.has(x));
  return false;
}

function sumarDias(fecha: string, n: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n))
    .toISOString()
    .slice(0, 10);
}

function diaDelMes(fecha: string): number {
  return Number(fecha.slice(8, 10));
}

function esFinDeMes(fecha: string): boolean {
  return sumarDias(fecha, 1).slice(5, 7) !== fecha.slice(5, 7);
}

function diaDeSemana(fecha: string): number {
  const [y, m, d] = fecha.split('-').map(Number);
  return (new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay() + 6) % 7;
}

function esFestivo(fecha: string): boolean {
  return holidaysOfYear(Number(fecha.slice(0, 4))).has(fecha);
}
