/**
 * Piezas comunes de la reconsulta periódica a la DIAN (Fase 10).
 *
 * Un documento solo se reconsulta si lleva más de `REPOSO_RECONSULTA_MS` en
 * `sent`: antes de eso puede que la transmisión que lo marcó siga en curso (o
 * que la DIAN aún no tenga el veredicto) y reenviarlo sería ruido.
 */
export const REPOSO_RECONSULTA_MS = 10 * 60_000;

/**
 * Tipos sin contingencia (Fase 9): las notas crédito y débito no tienen tipo
 * 03/04. Si la DIAN no responde quedan firmadas y en cola, y se reenvía el
 * MISMO XML cuando vuelve el servicio. La nómina (otra colección) tampoco.
 */
export const TIPOS_SIN_CONTINGENCIA = ['credit_note', 'debit_note'] as const;

/**
 * Cola de la reconsulta: lo que lleva más de `REPOSO_RECONSULTA_MS` en `sent`
 * y, además, lo que quedó `signed` CON su XML guardado sin llegar a salir (se
 * agotó el tiempo o la función murió entre firmar y enviar). Sin esto último un
 * documento sin contingencia quedaría firmado para siempre: nadie lo reenvía.
 * `tiposFirmados` limita la parte `signed` a esos tipos (las notas); sin él no
 * filtra por tipo (la nómina, que vive en su propia colección).
 * Nunca incluye `draft` (no hay XML que reenviar) ni lo que otro proceso tiene
 * bloqueado.
 */
export function filtroColaReconsulta(ahora: Date, tiposFirmados?: readonly string[]): { $and: Record<string, unknown>[] } {
  const corte = new Date(ahora.getTime() - REPOSO_RECONSULTA_MS);
  return {
    $and: [
      {
        $or: [
          { dianStatus: 'sent' as const, enviadoAt: { $lte: corte } },
          {
            dianStatus: 'signed' as const,
            xmlPath: { $gt: '' },
            updatedAt: { $lte: corte },
            ...(tiposFirmados ? { type: { $in: [...tiposFirmados] } } : {}),
          },
        ],
      },
      { $or: [{ bloqueoHasta: null }, { bloqueoHasta: { $lte: ahora } }] },
    ],
  };
}

/**
 * ¿La corrida movió el documento a un veredicto? `sent` y `signed` son la
 * cola: quedarse ahí (o pasar de `signed` a `sent`) no es avanzar.
 */
export function salioDeLaCola(dianStatus: string | undefined): boolean {
  return dianStatus !== 'sent' && dianStatus !== 'signed';
}

/** Lo que ve el usuario en el detalle de un documento sin contingencia en cola. */
export const RESUMEN_EN_COLA =
  'En cola: la DIAN aún no responde. Se reenviará automáticamente, con el mismo número y el mismo XML firmado, cuando vuelva el servicio';

/**
 * ¿Está en la cola de reenvío automático? Firmado con su XML o enviado sin
 * veredicto. Vale para las notas y la nómina (los tipos sin contingencia).
 */
export function enColaDeReenvio(d: { dianStatus?: string; xmlPath?: string | null }): boolean {
  return d.dianStatus === 'sent' || (d.dianStatus === 'signed' && Boolean(d.xmlPath));
}

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
