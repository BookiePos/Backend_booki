/**
 * Set de pruebas de HABILITACIÓN de la nómina electrónica (anexo técnico): la
 * DIAN exige N nóminas individuales (102) y N notas de ajuste (103) aceptadas
 * con el TestSetId del software de nómina. Dominio puro: sin red ni base.
 *
 * Los documentos del set NUNCA son nómina de la empresa: van a un trabajador
 * SINTÉTICO rotulado como prueba, con prefijos propios (`NEP` / `NAP`) y
 * consecutivos propios, que no comparten contador con los NE/NA reales.
 *
 * Cifras del set: el portal de la DIAN manda («Detalles del set de pruebas»).
 * Si muestra otras, se ajusta `SET_NOMINA_EXIGIDO` y nada más.
 */
import type { Centavos } from '../redondeo';
import { tiempoLaborado360 } from './consolidar';
import type { DocumentoNe } from './modelo';

export type TipoDocSetNe = 'nie' | 'niae';
/** `enviando`: grabado ANTES de salir a la red; si el proceso se corta, se reconsulta por CUNE antes de reenviar. */
export type EstadoDocSetNe = 'pendiente' | 'enviando' | 'enviado' | 'aceptado' | 'rechazado';

/** Documentos aceptados que exige el set, por tipo (guía DIAN de nómina electrónica). */
export const SET_NOMINA_EXIGIDO: Readonly<Record<TipoDocSetNe, number>> = { nie: 4, niae: 4 };

/** Prefijos de pruebas: distintos de los reales (`NE` / `NA`), así que nunca chocan en la DIAN ni en BookiPos. */
/** Cuántas de las notas del set son de Eliminar (el resto Reemplazar). Configurable: el portal de la DIAN manda. */
export const NOTAS_ELIMINAR_DEL_SET = 1;

/** Un `enviando` sin rastro en la DIAN solo se renumera pasado este tiempo (el envío es asíncrono y puede no estar indexado). */
export const UMBRAL_REENVIO_MS = 10 * 60_000;

export const PREFIJO_SET_NE: Readonly<Record<TipoDocSetNe, string>> = { nie: 'NEP', niae: 'NAP' };

export interface DocSetNe {
  tipo: TipoDocSetNe;
  /** Solo en notas: Reemplazar (TipoNota 1) o Eliminar (TipoNota 2). */
  nota?: 'reemplazar' | 'eliminar';
  /** Consecutivo propio del set (el número es prefijo + consecutivo). */
  numero: number;
  estado: EstadoDocSetNe;
  /** CUNE con el que se envió; null mientras no se arma. */
  cune: string | null;
  /** Fecha de emisión (YYYY-MM-DD): la nota de ajuste la cita como predecesor. */
  fecha: string | null;
  /** Identificador del envío asíncrono (SendTestSetAsync). */
  trackId: string | null;
  /** Lo que dijo la DIAN (o por qué sigue pendiente), en español. */
  mensaje: string | null;
  intentos: number;
  /** ISO del momento en que se grabó `enviando`/se envió. */
  enviadoAt?: string;
}

export interface SetHabilitacionNe {
  testSetId: string;
  iniciadaAt: string;
  /** Próximo consecutivo libre (los rechazados nunca reusan número). */
  siguiente: number;
  documentos: DocSetNe[];
}

const TIPOS: readonly TipoDocSetNe[] = ['nie', 'niae'];

const nuevoDoc = (tipo: TipoDocSetNe, numero: number, nota?: DocSetNe['nota']): DocSetNe => ({
  tipo,
  ...(nota ? { nota } : {}),
  numero,
  estado: 'pendiente',
  cune: null,
  fecha: null,
  trackId: null,
  mensaje: null,
  intentos: 0,
});

/**
 * Primer consecutivo de un set nuevo, corrido con el reloj (minutos): un set
 * reiniciado no repite números que la DIAN ya recibió.
 */
export function inicioSetNomina(ahoraMs: number): number {
  return 1 + (Math.floor(ahoraMs / 60_000) % 90_000_000) * 100;
}

/** Plan inicial: las nóminas primero (cada nota reemplaza a una nómina YA aceptada del set). */
export function planSetNomina(testSetId: string, ahora: Date): SetHabilitacionNe {
  let n = inicioSetNomina(ahora.getTime());
  const documentos = TIPOS.flatMap((tipo) =>
    Array.from({ length: SET_NOMINA_EXIGIDO[tipo] }, (_, i) =>
      nuevoDoc(tipo, n++, tipo === 'niae' ? (i >= SET_NOMINA_EXIGIDO.niae - NOTAS_ELIMINAR_DEL_SET ? 'eliminar' : 'reemplazar') : undefined),
    ),
  );
  return { testSetId, iniciadaAt: ahora.toISOString(), siguiente: n, documentos };
}

/** Los rechazados vuelven a la cola con un número nuevo (un número ya enviado no se reusa). */
export function reintentarRechazados(s: SetHabilitacionNe): SetHabilitacionNe {
  let siguiente = s.siguiente;
  const documentos = s.documentos.map((d) => (d.estado === 'rechazado' ? nuevoDoc(d.tipo, siguiente++, d.nota) : d));
  return { ...s, siguiente, documentos };
}

/** La nómina que reemplaza la k-ésima nota: la k-ésima nómina del set, solo si la DIAN ya la ACEPTÓ. null = la nota espera. */
export function predecesorDeNota(s: SetHabilitacionNe, indiceNota: number): DocSetNe | null {
  const k = s.documentos.slice(0, indiceNota).filter((d) => d.tipo === 'niae').length;
  const base = s.documentos.filter((d) => d.tipo === 'nie')[k];
  return base && base.estado === 'aceptado' && base.cune && base.fecha ? base : null;
}

export interface ResumenSetNe {
  porTipo: Record<TipoDocSetNe, { exigidos: number; aceptados: number; rechazados: number; enCurso: number }>;
  aprobada: boolean;
  aceptados: number;
  total: number;
}

export function resumenSetNomina(s: SetHabilitacionNe): ResumenSetNe {
  const contar = (docs: DocSetNe[], ...e: EstadoDocSetNe[]) => docs.filter((d) => e.includes(d.estado)).length;
  const porTipo = Object.fromEntries(
    TIPOS.map((t) => {
      const docs = s.documentos.filter((d) => d.tipo === t);
      return [
        t,
        {
          exigidos: SET_NOMINA_EXIGIDO[t],
          aceptados: contar(docs, 'aceptado'),
          rechazados: contar(docs, 'rechazado'),
          enCurso: contar(docs, 'pendiente', 'enviando', 'enviado'),
        },
      ];
    }),
  ) as ResumenSetNe['porTipo'];
  return {
    porTipo,
    aprobada: TIPOS.every((t) => porTipo[t].aceptados >= porTipo[t].exigidos),
    aceptados: porTipo.nie.aceptados + porTipo.niae.aceptados,
    total: s.documentos.length,
  };
}

export function mensajeAvance(s: SetHabilitacionNe): string {
  const r = resumenSetNomina(s);
  if (r.aprobada) return 'La DIAN aceptó el set de pruebas de nómina.';
  const notasEsperan = s.documentos.some((d) => d.tipo === 'niae' && d.estado === 'pendiente');
  return (
    `Set de pruebas de nómina en curso: ${r.aceptados} de ${r.total} documentos aceptados.` +
    (notasEsperan ? ' Las notas de ajuste salen cuando la DIAN acepte las nóminas.' : '')
  );
}

// ── Trabajador sintético ─────────────────────────────────────────────────────

/** Trabajador de prueba: sintético y rotulado como tal. No es persona real ni empleado de la empresa. */
export const TRABAJADOR_SINTETICO = {
  documento: '1020304050',
  primerApellido: 'PRUEBA',
  segundoApellido: 'HABILITACION',
  primerNombre: 'TRABAJADOR',
  ingreso: '2025-01-02',
  /** Sueldo mensual: $4.000.000 en centavos. Pasa de 2 SMMLV, así que NO lleva auxilio de transporte. */
  sueldo: 400_000_000 as Centavos,
} as const;

const ultimoDia = (mes: string): string => {
  const [y, m] = mes.split('-').map(Number) as [number, number];
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Mes cerrado anterior a `fecha` (YYYY-MM-DD → YYYY-MM). */
export function mesAnteriorA(fecha: string): string {
  const [y, m] = fecha.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** El documento del set: un mes completo, básico + salud + pensión, pagado en efectivo. Puro. */
export function documentoSintetico(
  lugar: { departamento: string; municipio: string; direccion: string },
  fecha: string,
): DocumentoNe {
  const mes = mesAnteriorA(fecha);
  const fin = ultimoDia(mes);
  const t = TRABAJADOR_SINTETICO;
  const aporte = (t.sueldo / 100) * 4; // 4 % exacto sobre un sueldo fijo
  return {
    periodo: {
      fechaIngreso: t.ingreso,
      fechaLiquidacionInicio: `${mes}-01`,
      fechaLiquidacionFin: fin,
      tiempoLaborado: tiempoLaborado360(t.ingreso, fin),
    },
    periodoNomina: '5',
    trabajador: {
      tipoTrabajador: '01',
      subTipoTrabajador: '00',
      altoRiesgoPension: false,
      tipoDocumento: '13',
      numeroDocumento: t.documento,
      primerApellido: t.primerApellido,
      segundoApellido: t.segundoApellido,
      primerNombre: t.primerNombre,
      lugarTrabajo: lugar,
      salarioIntegral: false,
      tipoContrato: '2',
      sueldo: t.sueldo,
    },
    pago: { forma: '1', metodo: '10' },
    fechasPagos: [fin],
    devengados: {
      basico: { dias: 30, sueldo: t.sueldo },
      horas: [],
      vacacionesComunes: [],
      vacacionesCompensadas: [],
      incapacidades: [],
      licenciasMP: [],
      bonificaciones: [],
      auxilios: [],
      otrosConceptos: [],
      comisiones: [],
      pagosTerceros: [],
    },
    deducciones: {
      salud: { porcentaje: 4, valor: aporte },
      fondoPension: { porcentaje: 4, valor: aporte },
      sindicatos: [],
      sanciones: [],
      libranzas: [],
      pagosTerceros: [],
      anticipos: [],
      otras: [],
    },
  };
}
