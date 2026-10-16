/**
 * Recorre empresas para un barrido periódico dentro del tope de tiempo de una
 * función serverless (ítem 2.10).
 *
 * - Procesa hasta `concurrencia` a la vez: cada empresa es una base aparte, así
 *   que no compiten por los mismos documentos.
 * - No empieza una empresa nueva pasado `hasta` (epoch ms): las que quedan se
 *   devuelven como `pendientes` para que el barrido lo reporte, en vez de que
 *   la función se corte a mitad sin decir nada.
 * - `desplazamiento` rota el punto de partida (p. ej. el día del año): si un
 *   día no alcanza el tiempo, al siguiente empiezan otras, y ninguna empresa se
 *   queda siempre al final de la fila.
 * - Un fallo no detiene a las demás; su clave queda en `fallidas`.
 */
export async function recorrerEmpresas<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
  opts: {
    concurrencia?: number;
    hasta: number;
    desplazamiento?: number;
    clave?: (item: T) => string;
    ahora?: () => number;
  },
): Promise<{ procesadas: number; pendientes: number; fallidas: string[] }> {
  const ahora = opts.ahora ?? Date.now;
  const clave = opts.clave ?? ((x: T) => String(x));
  const n = items.length;
  const inicio = n > 0 ? (((opts.desplazamiento ?? 0) % n) + n) % n : 0;
  const cola = [...items.slice(inicio), ...items.slice(0, inicio)];
  const fallidas: string[] = [];
  let siguiente = 0;
  let procesadas = 0;

  const trabajador = async () => {
    while (siguiente < cola.length && ahora() < opts.hasta) {
      const item = cola[siguiente++] as T;
      try {
        await fn(item);
      } catch {
        fallidas.push(clave(item));
      }
      procesadas++;
    }
  };

  const hilos = Math.max(1, Math.min(opts.concurrencia ?? 5, n));
  await Promise.all(Array.from({ length: hilos }, trabajador));
  return { procesadas, pendientes: n - procesadas, fallidas };
}
