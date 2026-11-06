/**
 * Piezas comunes de la reconsulta periódica a la DIAN (Fase 10).
 *
 * Un documento solo se reconsulta si lleva más de `REPOSO_RECONSULTA_MS` en
 * `sent`: antes de eso puede que la transmisión que lo marcó siga en curso (o
 * que la DIAN aún no tenga el veredicto) y reenviarlo sería ruido.
 */
export const REPOSO_RECONSULTA_MS = 10 * 60_000;

/** Documentos (y sets) que se tocan por empresa en cada corrida. */
export const LIMITE_RECONSULTA_POR_EMPRESA = 10;

/** No se empieza otro documento si quedan menos de esto antes del plazo global. */
export const MARGEN_PLAZO_RECONSULTA_MS = 60_000;

export interface CifrasReconsulta {
  /** Documentos o sets que se intentaron. */
  revisados: number;
  /** Los que cambiaron de estado (veredicto de la DIAN) o avanzaron. */
  avanzados: number;
  /** Los que no se pudieron tocar por una regla (gate, otro proceso, sin config): se reintentan solos. */
  omitidos: number;
  /** Fallos reales (inesperados). Hacen que la corrida responda 500. */
  errores: number;
}

export const cifrasVacias = (): CifrasReconsulta => ({ revisados: 0, avanzados: 0, omitidos: 0, errores: 0 });

export const sumarCifras = (a: CifrasReconsulta, b: CifrasReconsulta): CifrasReconsulta => ({
  revisados: a.revisados + b.revisados,
  avanzados: a.avanzados + b.avanzados,
  omitidos: a.omitidos + b.omitidos,
  errores: a.errores + b.errores,
});

/** ¿Es un rechazo de regla (HTTP 4xx) y no un fallo inesperado? */
export function esRechazoDeRegla(err: unknown): boolean {
  const status = (err as { getStatus?: () => number })?.getStatus?.();
  return typeof status === 'number' && status >= 400 && status < 500;
}
