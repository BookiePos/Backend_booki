import type { Conteo } from './en-cada-empresa';
import { recargosVigentes } from '../modules/payroll/domain/payroll-calc';
import {
  DEFAULT_PAYROLL_SETTINGS,
  type RecargoFactores,
} from '../modules/payroll/domain/payroll.constants';

/**
 * Revisión del ítem 1.18 (H3). Desde que el dominical va por fecha, nómina dejó
 * de leer dos fuentes que podían traer un recargo MAYOR que el legal:
 *
 * - `payroll_settings.recargos`: el dominical y los combinados del expediente
 *   (eran una copia fija del 90 %).
 * - Las vigencias de `recargo.*` en Parámetros sin autor (semillas del sistema).
 *
 * Si alguna empresa tenía ahí un valor por encima de `recargosVigentes`, pudo
 * creer que lo había pactado. Este informe las lista para revisarlas a mano: si
 * fue un pacto real, se registra como vigencia con autor en Parámetros. Solo
 * LEE; no hay corrección automática posible porque no se sabe si hubo pacto.
 */

export interface Exceso {
  origen: 'expediente' | 'parametros';
  campo: string;
  valor: number;
  legal: number;
  /** Fecha con que se comparó (hoy o el inicio de la vigencia). */
  desde: string;
}

export interface VigenciaParametro {
  key: string;
  value: unknown;
  effectiveFrom: string;
  createdByEmail?: string;
}

/** Factores mínimos (art. 168) para que `recargosVigentes` dé solo el legal. */
const SIN_PACTO = { recargos: DEFAULT_PAYROLL_SETTINGS.recargos };

/** Holgura para no listar 1,25 frente a 0,35 + 0,9 en coma flotante. */
const EPS = 1e-9;

const CAMPOS_EXPEDIENTE = [
  'dominical',
  'nocturnoDominical',
  'extraDiurnaDominical',
  'extraNocturnaDominical',
] as const;

const PARAMETRO_A_CAMPO: Record<string, keyof RecargoFactores> = {
  'recargo.dominical_festivo': 'dominical',
  'recargo.nocturno': 'recargoNocturno',
  'recargo.hora_extra_diurna': 'extraDiurna',
  'recargo.hora_extra_nocturna': 'extraNocturna',
};

/** Recargos del expediente que superan el legal vigente en `fecha`. */
export function excesosExpediente(
  recargos: Partial<RecargoFactores> | undefined,
  fecha: string,
): Exceso[] {
  const legal = recargosVigentes(fecha, SIN_PACTO);
  const out: Exceso[] = [];
  for (const campo of CAMPOS_EXPEDIENTE) {
    const valor = recargos?.[campo];
    if (typeof valor === 'number' && valor > legal[campo] + EPS) {
      out.push({ origen: 'expediente', campo, valor, legal: legal[campo], desde: fecha });
    }
  }
  return out;
}

/**
 * Vigencias de `recargo.*` sin autor cuyo valor supera el legal al inicio de
 * su vigencia. Las que tienen autor son pactos y nómina sí las aplica.
 */
export function excesosParametros(versiones: VigenciaParametro[]): Exceso[] {
  const out: Exceso[] = [];
  for (const v of versiones) {
    const campo = PARAMETRO_A_CAMPO[v.key];
    if (!campo || v.createdByEmail || typeof v.value !== 'number') continue;
    const valor = v.value / 100;
    const legal = recargosVigentes(v.effectiveFrom, SIN_PACTO)[campo];
    if (valor > legal + EPS) {
      out.push({ origen: 'parametros', campo: v.key, valor, legal, desde: v.effectiveFrom });
    }
  }
  return out;
}

/** Conteo de la empresa para el resumen de `enCadaEmpresa`. */
export function contarExcesos(expediente: Exceso[], parametros: Exceso[]): Conteo {
  return {
    expediente: expediente.length,
    parametros: parametros.length,
    aRevisar: expediente.length + parametros.length > 0 ? 1 : 0,
  };
}

/** `--aplicar` no corrige: decidir si hubo pacto es una revisión a mano. */
export function revisarAMano(): Promise<never> {
  return Promise.reject(
    new Error(
      'Solo informe: si el recargo fue pactado, regístralo a mano como vigencia con autor en Parámetros.',
    ),
  );
}
