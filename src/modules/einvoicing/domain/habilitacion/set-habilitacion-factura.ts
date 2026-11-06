/**
 * Set de pruebas de HABILITACIÓN de la factura electrónica de venta (y, con la
 * estructura lista pero DESACTIVADA, del documento equivalente POS). Dominio
 * puro: sin red ni base.
 *
 * Adaptado de AlíaCorp (`apps/erp/lib/dian/habilitacion-estado.ts` y
 * `habilitacion.ts`, probado contra la DIAN real en Crunchy Munch, S110) a las
 * convenciones de BookiPos y a la habilitación de nómina
 * (`nomina/set-habilitacion.ts`): colección propia, `enviando` grabado antes
 * de salir, renumeración solo tras «no recibido».
 *
 * Los documentos del set NO son facturas del negocio: llevan la resolución
 * PÚBLICA de habilitación de la DIAN (prefijo SETP, la misma para todos los
 * facturadores) a un adquiriente de prueba, con líneas sintéticas. Nunca tocan
 * la numeración, la cartera, el inventario ni `electronic_documents`.
 *
 * Cifras del set: el portal de la DIAN manda («Detalles del set de pruebas»).
 * Si muestra otras, se ajusta `SET_FACTURA_EXIGIDO` y nada más.
 */

export type TipoDocSet = 'fv' | 'pos' | 'nc' | 'nd';
/** Qué se habilita: la factura de venta (con sus notas) o el documento equivalente POS. */
export type ClaseSet = 'fe' | 'pos';
/**
 * `enviando`: grabado ANTES de salir a la red; si el proceso se corta se reconsulta por CUFE antes de reenviar.
 * `set_aceptado`: la DIAN no juzgó el documento porque el SET ya estaba «Aceptado» (AlíaCorp S110, Crunchy Munch);
 * no es rechazo ni cuenta como aceptado: vale el veredicto del set (`aceptadoPorDian`).
 */
export type EstadoDocSet = 'pendiente' | 'enviando' | 'enviado' | 'aceptado' | 'rechazado' | 'set_aceptado';

/**
 * Documentos de FACTURA que deben quedar ACEPTADOS.
 * - `fv`: 8 facturas de venta. Cifra de AlíaCorp (`SET_PRUEBAS_EXIGIDO`), que la
 *   DIAN mostró en el portal de habilitación. A confirmar en el portal del piloto.
 * - `nc` / `nd`: 1 nota crédito y 1 nota débito (cifra de AlíaCorp). Cada una referencia una factura ACEPTADA
 *   del mismo set y solo sale cuando esa factura ya fue aceptada (`baseDeNota`). Si el portal pide otras cifras,
 *   se ajustan aquí. La DIAN suele dar el set por aceptado antes de evaluar las notas («se encuentra Aceptado»,
 *   S110); `aceptadoPorDian` lo cubre.
 */
export const SET_FACTURA_EXIGIDO: Readonly<Record<'fv' | 'nc' | 'nd', number>> = { fv: 8, nc: 1, nd: 1 };

/**
 * Documentos del POS que exige su set. A CONFIRMAR EN HABILITACIÓN: ni el anexo DE v1.0 ni la caja de herramientas
 * dicen la composición (`fe-fase7-anexo-pos.md`, §5 y «a confirmar» 8-9); la muestra el portal del DE.
 */
export const SET_POS_EXIGIDO: Readonly<Record<'pos', number>> = { pos: 8 };

/**
 * Interruptor del set del POS. APAGADO a propósito: no se sabe si el DE usa el mismo SoftwareID, PIN y TestSetId de
 * la factura o un registro aparte (`fiscal_emitters` solo separa factura y nómina). Se enciende cuando el dueño
 * confirme en el portal. Con él apagado el endpoint del POS responde 409 con ese motivo.
 */
export const HABILITACION_POS_ACTIVA = false;

export const MENSAJE_POS_DESACTIVADO =
  'La habilitación automática del documento equivalente POS está desactivada: falta confirmar en el portal de la DIAN si usa el mismo SoftwareID, PIN y TestSetId de la factura y cuántos documentos exige su set.';

export const EXIGIDO_POR_CLASE: Readonly<Record<ClaseSet, Readonly<Partial<Record<TipoDocSet, number>>>>> = {
  fe: SET_FACTURA_EXIGIDO,
  pos: SET_POS_EXIGIDO,
};

/** Los tipos de cada set en el orden de envío (el documento base primero: las notas lo referencian). */
export const TIPOS_DEL_SET: Readonly<Record<ClaseSet, readonly TipoDocSet[]>> = {
  fe: ['fv', 'nc', 'nd'],
  pos: ['pos'],
};

export const ETIQUETA_DOC_SET: Readonly<Record<TipoDocSet, string>> = {
  fv: 'Factura de venta',
  pos: 'Documento equivalente POS',
  nc: 'Nota crédito',
  nd: 'Nota débito',
};

/**
 * Resolución de numeración del ambiente de HABILITACIÓN: pública, igual para todos los facturadores (la que usa la
 * referencia APIDIAN, el fixture de conformidad y `RESOLUCION_SET_PRUEBAS` de AlíaCorp `habilitacion.ts`). No es una
 * credencial. A CONFIRMAR EN HABILITACIÓN contra `GetNumberingRange` del piloto.
 */
export const RESOLUCION_SETP = {
  numero: '18760000001',
  prefijo: 'SETP',
  desde: 990_000_000,
  hasta: 995_000_000,
  vigenciaDesde: '2019-01-19',
  vigenciaHasta: '2030-01-19',
  /** Clave técnica pública de la resolución de pruebas (alimenta el CUFE de la factura). */
  claveTecnica: 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c',
} as const;

/** Prefijos de los documentos del set: el POS comparte la resolución de pruebas SETP (a confirmar). */
export const PREFIJO_SET: Readonly<Record<TipoDocSet, string>> = { fv: 'SETP', pos: 'SETP', nc: 'NC', nd: 'ND' };

/** Un `enviando` sin rastro en la DIAN solo se renumera pasado este tiempo (el envío es asíncrono y puede no estar indexado). */
export const UMBRAL_REENVIO_MS = 10 * 60_000;

/** Tope de la constancia de rechazos (la DIAN admite 50 envíos por set). */
const TOPE_HISTORIAL = 50;

export interface DocSet {
  tipo: TipoDocSet;
  /** Consecutivo dentro del rango SETP (las notas usan el mismo contador con su prefijo NC/ND). */
  numero: number;
  estado: EstadoDocSet;
  /** CUFE (factura) o CUDE (POS, notas) con el que se envió; null mientras no se arma. */
  codigo: string | null;
  /** Fecha de emisión (YYYY-MM-DD): una nota la cita como referencia. */
  fecha: string | null;
  /** Identificador del envío asíncrono (ZipKey de SendTestSetAsync). */
  trackId: string | null;
  /** Lo que dijo la DIAN (o por qué sigue pendiente), en español. */
  mensaje: string | null;
  intentos: number;
  /** ISO del momento en que se grabó `enviando`/se envió. */
  enviadoAt?: string;
}

export interface SetHabilitacion {
  testSetId: string;
  clase: ClaseSet;
  iniciadaAt: string;
  /** Próximo consecutivo libre (los rechazados nunca reusan número). */
  siguiente: number;
  documentos: DocSet[];
  /** La DIAN respondió que el set ya está «Aceptado»: aprobado aunque no se hayan contado todos los documentos. */
  aceptadoPorDian?: boolean;
  /** Rechazados que se reemplazaron al reintentar: la constancia de lo que dijo la DIAN no se pierde. */
  historial?: DocSet[];
  /** ISO del momento en que el emisor quedó marcado «listo para producción». */
  listoMarcadoAt?: string;
}

const nuevoDoc = (tipo: TipoDocSet, numero: number): DocSet => ({
  tipo,
  numero,
  estado: 'pendiente',
  codigo: null,
  fecha: null,
  trackId: null,
  mensaje: null,
  intentos: 0,
});

/**
 * Primer consecutivo de un set nuevo, dentro del rango SETP y corrido con el reloj (minutos): un set reiniciado no
 * repite números que la DIAN ya recibió. Misma idea que `inicioDelSet` de AlíaCorp.
 */
export function inicioSet(ahoraMs: number): number {
  const tramo = RESOLUCION_SETP.hasta - RESOLUCION_SETP.desde - 1_000;
  return RESOLUCION_SETP.desde + 1 + (Math.floor(ahoraMs / 60_000) % tramo);
}

/** Plan inicial: lo que exige el set, en orden de envío. */
export function planSet(clase: ClaseSet, testSetId: string, ahora: Date): SetHabilitacion {
  let n = inicioSet(ahora.getTime());
  const exigido = EXIGIDO_POR_CLASE[clase];
  const documentos = TIPOS_DEL_SET[clase].flatMap((tipo) =>
    Array.from({ length: exigido[tipo] ?? 0 }, () => nuevoDoc(tipo, n++)),
  );
  return { testSetId, clase, iniciadaAt: ahora.toISOString(), siguiente: n, documentos };
}

/** Los rechazados vuelven a la cola con un número nuevo; el rechazo pasa al `historial`. */
export function reintentarRechazados(s: SetHabilitacion): SetHabilitacion {
  const rechazados = s.documentos.filter((d) => d.estado === 'rechazado');
  if (rechazados.length === 0) return s;
  let siguiente = s.siguiente;
  const documentos = s.documentos.map((d) => (d.estado === 'rechazado' ? nuevoDoc(d.tipo, siguiente++) : d));
  const historial = [...(s.historial ?? []), ...rechazados].slice(-TOPE_HISTORIAL);
  return { ...s, siguiente, documentos, historial };
}

/**
 * La factura base de una nota: la primera `fv` ACEPTADA (con CUFE y fecha). Si la DIAN valida la nota antes que su
 * base, la rechaza y el reintento gasta un número del tope; sin base aceptada la nota espera (null).
 */
export function baseDeNota(s: SetHabilitacion): DocSet | null {
  return s.documentos.find((d) => d.tipo === 'fv' && d.estado === 'aceptado' && d.codigo && d.fecha) ?? null;
}

// ── Veredicto del SET («se encuentra Aceptado»), de AlíaCorp `habilitacion-estado.ts` ───────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * «Set de prueba con identificador … se encuentra Aceptado.»: la DIAN lo contesta (con IsValid=false) a lo que llega
 * con el set ya cerrado. Es el veredicto del SET —aprobado—, no un rechazo del documento. Una negación («no se
 * encuentra Aceptado») NO cuenta, y si nombra un set tiene que ser el PROPIO.
 */
export function esSetAceptadoDian(t: string | null | undefined, testSetId: string): boolean {
  if (!t || !/set de prueba[\s\S]{0,80}?(?<!\bno\s+)se encuentra\s+aceptado/i.test(t)) return false;
  const ids = t.match(UUID);
  return !ids || ids.some((id) => id.toLowerCase() === testSetId.toLowerCase());
}

/** Mensaje del documento que recibió el veredicto de SU set (null si la DIAN no dijo «se encuentra Aceptado»). */
export function mensajeSetAceptado(textos: readonly (string | null | undefined)[], testSetId: string): string | null {
  const t = textos.find((x) => esSetAceptadoDian(x, testSetId));
  return t ? `La DIAN dio tu set de pruebas por aceptado (respondió: «${t.trim()}»).` : null;
}

export interface ResumenTipo {
  exigidos: number;
  aceptados: number;
  rechazados: number;
  enCurso: number;
}

export interface ResumenSet {
  porTipo: Partial<Record<TipoDocSet, ResumenTipo>>;
  aprobada: boolean;
  /** Documentos aceptados (de los exigidos). */
  aceptados: number;
  /** Documentos exigidos en total. */
  exigidos: number;
  total: number;
}

export function resumenSet(s: SetHabilitacion): ResumenSet {
  const exigido = EXIGIDO_POR_CLASE[s.clase];
  const contar = (docs: DocSet[], ...e: EstadoDocSet[]) => docs.filter((d) => e.includes(d.estado)).length;
  const tipos = TIPOS_DEL_SET[s.clase].filter((t) => (exigido[t] ?? 0) > 0);
  const porTipo: Partial<Record<TipoDocSet, ResumenTipo>> = {};
  for (const t of tipos) {
    const docs = s.documentos.filter((d) => d.tipo === t);
    porTipo[t] = {
      exigidos: exigido[t] ?? 0,
      aceptados: contar(docs, 'aceptado'),
      rechazados: contar(docs, 'rechazado'),
      enCurso: contar(docs, 'pendiente', 'enviando', 'enviado'),
    };
  }
  const exigidos = tipos.reduce((a, t) => a + (exigido[t] ?? 0), 0);
  const aceptados = tipos.reduce((a, t) => a + Math.min(porTipo[t]!.aceptados, exigido[t] ?? 0), 0);
  return {
    porTipo,
    aprobada:
      s.aceptadoPorDian === true || (exigidos > 0 && tipos.every((t) => porTipo[t]!.aceptados >= (exigido[t] ?? 0))),
    aceptados,
    exigidos,
    total: s.documentos.length,
  };
}

export function mensajeAvance(s: SetHabilitacion): string {
  const nombre = s.clase === 'pos' ? 'del documento equivalente POS' : 'de la factura electrónica';
  const r = resumenSet(s);
  if (r.aprobada) return `La DIAN aceptó el set de pruebas ${nombre}.`;
  return `Set de pruebas ${nombre} en curso: ${r.aceptados} de ${r.exigidos} documentos aceptados.`;
}
