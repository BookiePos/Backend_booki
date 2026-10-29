/**
 * Estado de una resolución de numeración de la DIAN.
 *
 * La autorización de numeración es un recurso que se agota por dos lados a la
 * vez: por **números** (el rango autorizado) y por **tiempo** (la vigencia). Que
 * se acabe cualquiera de los dos deja al negocio sin poder facturar, y conseguir
 * una nueva ante la DIAN no es inmediato.
 *
 * Por eso el estado se calcula con margen y no solo cuando ya no queda nada:
 * avisar el día que se agota el rango es avisar tarde.
 *
 * Dominio puro: sin Nest ni Mongoose, para poder probarlo sin base de datos.
 */

/** Umbral de consumo del rango a partir del cual conviene ir tramitando otra. */
export const RANGO_AVISO = 0.8;

/** Días antes del vencimiento en que se empieza a avisar. */
export const DIAS_AVISO = 30;

export interface ResolucionDatos {
  numero?: string;
  fechaResolucion?: Date;
  prefijo?: string;
  rangoDesde?: number;
  rangoHasta?: number;
  vigenciaDesde?: Date;
  vigenciaHasta?: Date;
  claveTecnica?: string;
}

/**
 * Estados posibles, del más grave al más tranquilo. El orden importa: un mismo
 * caso puede cumplir varios y se reporta el que primero exige actuar.
 */
export type EstadoResolucion =
  | 'sin_configurar'
  | 'incompleta'
  | 'vencida'
  | 'rango_agotado'
  | 'aun_no_vigente'
  | 'por_vencer'
  | 'rango_bajo'
  | 'ok';

export interface ResolutionStatus {
  estado: EstadoResolucion;
  /** Frases listas para mostrar, en orden de urgencia. */
  alertas: string[];
  /** ¿Se puede emitir ahora mismo con esta resolución? */
  puedeEmitir: boolean;
  claveTecnicaOk: boolean;
  consecutivo: {
    /** Número que le tocaría a la próxima factura. */
    siguiente?: number;
    usados: number;
    restantes?: number;
    total?: number;
    /** 0 a 1. Sin rango definido, indefinido. */
    consumido?: number;
  };
  vigencia: {
    diasRestantes?: number;
    vencida: boolean;
    aunNoVigente: boolean;
  };
}

/** Días completos entre dos fechas (positivo si `hasta` es futuro). */
function diasEntre(desde: Date, hasta: Date): number {
  const MS_DIA = 24 * 60 * 60 * 1000;
  const a = Date.UTC(desde.getFullYear(), desde.getMonth(), desde.getDate());
  const b = Date.UTC(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
  return Math.round((b - a) / MS_DIA);
}

/**
 * Calcula el estado a partir de la resolución y del consecutivo que va.
 *
 * `siguiente` es el número que le tocaría a la próxima factura; se calcula
 * fuera porque vive en el contador atómico, no en la resolución.
 */
export function computeResolutionStatus(
  resolucion: ResolucionDatos | undefined,
  siguiente: number | undefined,
  hoy: Date = new Date(),
): ResolutionStatus {
  const vacio: ResolutionStatus = {
    estado: 'sin_configurar',
    alertas: ['Esta sede todavía no tiene resolución de numeración registrada.'],
    puedeEmitir: false,
    claveTecnicaOk: false,
    consecutivo: { usados: 0 },
    vigencia: { vencida: false, aunNoVigente: false },
  };
  if (!resolucion || !resolucion.numero) return vacio;

  const { rangoDesde, rangoHasta, vigenciaDesde, vigenciaHasta } = resolucion;
  const claveTecnicaOk = Boolean(resolucion.claveTecnica);

  // ── Consecutivo ──────────────────────────────────────────────────────────
  const desde = rangoDesde ?? 1;
  const proximo = siguiente ?? desde;
  const usados = Math.max(0, proximo - desde);
  const total = rangoHasta != null ? rangoHasta - desde + 1 : undefined;
  const restantes = rangoHasta != null ? rangoHasta - proximo + 1 : undefined;
  const consumido =
    total && total > 0 ? Math.min(1, usados / total) : undefined;

  // ── Vigencia ─────────────────────────────────────────────────────────────
  const diasRestantes = vigenciaHasta ? diasEntre(hoy, vigenciaHasta) : undefined;
  const vencida = diasRestantes !== undefined && diasRestantes < 0;
  const aunNoVigente = Boolean(vigenciaDesde && diasEntre(hoy, vigenciaDesde) > 0);

  // ── Alertas, de la más urgente a la menos ────────────────────────────────
  const alertas: string[] = [];
  let estado: EstadoResolucion = 'ok';

  if (!claveTecnicaOk || rangoHasta == null) {
    estado = 'incompleta';
    if (!claveTecnicaOk) {
      alertas.push(
        'Falta la clave técnica: sin ella no se puede calcular el CUFE y no se emite ninguna factura.',
      );
    }
    if (rangoHasta == null) {
      alertas.push(
        'Falta el rango autorizado: sin él no se puede saber cuántos números quedan.',
      );
    }
  }

  if (vencida) {
    estado = 'vencida';
    alertas.unshift(
      `La resolución venció hace ${Math.abs(diasRestantes as number)} día(s). Hay que renovarla antes de seguir facturando.`,
    );
  } else if (restantes !== undefined && restantes <= 0) {
    estado = 'rango_agotado';
    alertas.unshift(
      'Se agotó el rango autorizado. Solicita una resolución nueva a la DIAN.',
    );
  } else if (aunNoVigente) {
    estado = 'aun_no_vigente';
    alertas.unshift('La vigencia de esta resolución todavía no ha empezado.');
  } else if (diasRestantes !== undefined && diasRestantes <= DIAS_AVISO) {
    estado = 'por_vencer';
    alertas.unshift(
      `Vence en ${diasRestantes} día(s). Tramita la renovación con tiempo: la DIAN no responde al instante.`,
    );
  } else if (consumido !== undefined && consumido >= RANGO_AVISO) {
    estado = 'rango_bajo';
    alertas.unshift(
      `Quedan ${restantes} número(s) de ${total}. Conviene pedir la próxima resolución ya.`,
    );
  }

  const puedeEmitir =
    claveTecnicaOk &&
    !vencida &&
    !aunNoVigente &&
    (restantes === undefined || restantes > 0);

  return {
    estado,
    alertas,
    puedeEmitir,
    claveTecnicaOk,
    consecutivo: { siguiente: proximo, usados, restantes, total, consumido },
    vigencia: { diasRestantes, vencida, aunNoVigente },
  };
}
