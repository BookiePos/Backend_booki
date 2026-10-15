import { holidaysOfYear } from './colombia-holidays';

/**
 * Días de descanso remunerado del período (ítem 1.19), que se suman a los días
 * con turno para liquidar el salario:
 *
 * - Domingo (CST arts. 172 y 173): se paga si el trabajador laboró todos los
 *   días laborables de esa semana. Los festivos de la semana no se exigen.
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
    if (trabajados.has(d)) continue;
    const dow = diaDeSemana(d); // 0 = lunes … 6 = domingo
    const lunes = sumarDias(d, -dow);
    const laborables = Array.from({ length: diasLaborablesSemana }, (_, i) =>
      sumarDias(lunes, i),
    );
    if (dow === 6) {
      const exigidos = laborables.filter((x) => !esFestivo(x));
      if (exigidos.length > 0 && exigidos.every((x) => trabajados.has(x))) pagados++;
    } else if (esFestivo(d) && dow < diasLaborablesSemana) {
      if (laborables.some((x) => trabajados.has(x))) pagados++;
    }
  }
  return pagados;
}

function sumarDias(fecha: string, n: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n))
    .toISOString()
    .slice(0, 10);
}

function diaDeSemana(fecha: string): number {
  const [y, m, d] = fecha.split('-').map(Number);
  return (new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay() + 6) % 7;
}

function esFestivo(fecha: string): boolean {
  return holidaysOfYear(Number(fecha.slice(0, 4))).has(fecha);
}
