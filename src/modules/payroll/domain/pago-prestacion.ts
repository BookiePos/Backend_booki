/**
 * Pago de prestaciones sociales fuera del retiro (decisión 2 del dueño, Fase 8):
 * la prima de servicios del semestre, la consignación de las cesantías del año
 * y los intereses sobre esas cesantías. La nómina de cada mes solo las
 * PROVISIONA (2610); este registro es el evento del pago, que consume ese
 * pasivo y que la nómina electrónica reporta en el mes en que se paga (nodos
 * `Primas` y `Cesantias`, anexo §3 de `fe-fase8-anexo-nomina.md`).
 *
 * Puro: valida y avisa; no toca la base ni calcula el monto (lo declara quien
 * registra el pago, con lo que de verdad se pagó).
 */
import { MEDIOS_PAGO_NOMINA } from './pago-nomina';
import { dias360Inclusivo } from './liquidacion-calc';

export const TIPOS_PRESTACION = ['prima', 'cesantias', 'intereses_cesantias'] as const;
export type TipoPrestacion = (typeof TIPOS_PRESTACION)[number];

export const NOMBRE_PRESTACION: Record<TipoPrestacion, string> = {
  prima: 'prima de servicios',
  cesantias: 'cesantías',
  intereses_cesantias: 'intereses sobre cesantías',
};

/** A quién se le entregan las cesantías: al fondo (lo normal, Ley 50/1990 art. 99) o al trabajador. */
export const DESTINOS_CESANTIAS = ['fondo', 'trabajador'] as const;
export type DestinoCesantias = (typeof DESTINOS_CESANTIAS)[number];

export const ESTADOS_PAGO_PRESTACION = ['registrado', 'anulado'] as const;
export type EstadoPagoPrestacion = (typeof ESTADOS_PAGO_PRESTACION)[number];

export interface PagoPrestacionEntrada {
  tipo: string;
  /** Lo pagado, en pesos enteros, ANTES de la retención. */
  monto: number;
  /** Retención en la fuente practicada sobre la prima (pesos). Las cesantías y sus intereses nunca la llevan. */
  retencionFuente?: number;
  /** Tramo que cubre el pago (YYYY-MM-DD): el semestre de la prima o el año de las cesantías. */
  periodoDesde: string;
  periodoHasta: string;
  /** Código DIAN 5.3.3.2 (10 efectivo, 20 cheque, 42 consignación, 47 transferencia). */
  medioPago: string;
  /** Fecha real del egreso (YYYY-MM-DD). */
  fechaPago: string;
  destino?: string;
}

/** Lo que se lee del expediente para decidir si al trabajador se le deben prestaciones. */
export interface EmpleadoPrestacion {
  contractType?: string;
  salaryType?: string;
  hireDate?: string;
}

const esFechaReal = (f: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
};

const esPesoEntero = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Semestre calendario de una fecha: 1 (enero–junio) o 2 (julio–diciembre). */
const semestreDe = (fecha: string): 1 | 2 => (Number(fecha.slice(5, 7)) <= 6 ? 1 : 2);

/** Días que cubre el pago por el método comercial 360, contando ambos extremos: un semestre son 180 y un año 360. */
export function diasCubiertos(desde: string, hasta: string): number {
  return dias360Inclusivo(desde, hasta);
}

/**
 * Valida el pago declarado. `hoy` es la fecha de Colombia (YYYY-MM-DD).
 * Devuelve el motivo del rechazo o null.
 *
 * - Prima: un solo semestre calendario (art. 306 CST: se paga por semestre).
 * - Cesantías e intereses: un solo año calendario (Ley 50/1990 art. 99 num. 1:
 *   liquidación definitiva al 31 de diciembre; Ley 52/1975 art. 1).
 * - La fecha es la del egreso real: ni futura ni anterior al tramo que cubre.
 * - Retención en la fuente: solo sobre la prima; las cesantías y sus intereses
 *   no la llevan (DUR 1625/2016 art. 1.2.4.1.11).
 */
export function motivoPagoPrestacionInvalido(p: PagoPrestacionEntrada, hoy: string): string | null {
  if (!(TIPOS_PRESTACION as readonly string[]).includes(p.tipo)) {
    return 'El tipo debe ser prima, cesantias o intereses_cesantias.';
  }
  const tipo = p.tipo as TipoPrestacion;
  if (!esPesoEntero(p.monto) || p.monto <= 0) return 'El monto pagado debe ser un número entero de pesos mayor que cero.';
  if (!esFechaReal(p.periodoDesde) || !esFechaReal(p.periodoHasta)) {
    return 'El periodo que cubre el pago necesita dos fechas válidas (YYYY-MM-DD).';
  }
  if (p.periodoDesde > p.periodoHasta) return 'El periodo que cubre el pago termina antes de empezar.';
  const mismoAnio = p.periodoDesde.slice(0, 4) === p.periodoHasta.slice(0, 4);
  if (tipo === 'prima') {
    if (!mismoAnio || semestreDe(p.periodoDesde) !== semestreDe(p.periodoHasta)) {
      return 'La prima se paga por semestre (art. 306 CST): el periodo debe quedar dentro de enero–junio o de julio–diciembre del mismo año. Registra un pago por cada semestre.';
    }
  } else if (!mismoAnio) {
    return `Las ${NOMBRE_PRESTACION[tipo]} se liquidan por año calendario (Ley 50/1990 art. 99; Ley 52/1975): el periodo debe quedar dentro de un solo año. Registra un pago por cada año.`;
  }
  if (!(MEDIOS_PAGO_NOMINA as readonly string[]).includes(p.medioPago)) {
    return 'El medio de pago debe ser efectivo (10), cheque (20), consignación (42) o transferencia (47).';
  }
  if (!esFechaReal(p.fechaPago)) return 'La fecha de pago no es una fecha válida (YYYY-MM-DD).';
  if (p.fechaPago > hoy) return `La fecha de pago (${p.fechaPago}) es futura: declara la fecha real en que se pagó.`;
  if (p.fechaPago < p.periodoDesde) {
    return `La fecha de pago (${p.fechaPago}) es anterior al periodo que cubre (${p.periodoDesde}): no se paga una prestación que aún no empieza a causarse.`;
  }
  const retencion = p.retencionFuente ?? 0;
  if (!esPesoEntero(retencion) || retencion < 0) return 'La retención en la fuente debe ser un número entero de pesos, no negativo.';
  if (retencion > 0 && tipo !== 'prima') {
    return 'Las cesantías y sus intereses no llevan retención en la fuente (DUR 1625/2016 art. 1.2.4.1.11): déjala en 0.';
  }
  if (retencion >= p.monto) return 'La retención en la fuente no puede igualar ni superar el monto pagado.';
  if (p.destino !== undefined && !(DESTINOS_CESANTIAS as readonly string[]).includes(p.destino)) {
    return 'El destino de las cesantías debe ser fondo o trabajador.';
  }
  if (p.destino !== undefined && tipo !== 'cesantias') return 'El destino (fondo o trabajador) solo aplica a las cesantías.';
  return null;
}

/**
 * ¿Al trabajador se le deben prestaciones? Devuelve el motivo del rechazo o null.
 * - Contratista: no hay relación laboral, no causa prestaciones.
 * - Aprendiz: apoyo de sostenimiento sin prestaciones (Ley 789/2002 art. 30).
 * - Salario integral: ya incluye prima y cesantías (art. 132 CST num. 2).
 * - El tramo no puede terminar antes del ingreso.
 */
export function motivoEmpleadoSinPrestacion(e: EmpleadoPrestacion, p: { tipo: TipoPrestacion; periodoHasta: string }): string | null {
  if (e.contractType === 'prestacion_servicios') {
    return 'Tiene contrato de prestación de servicios: no es una relación laboral y no causa prima ni cesantías.';
  }
  if (e.contractType === 'aprendizaje') {
    return 'Tiene contrato de aprendizaje: recibe apoyo de sostenimiento y no causa prestaciones sociales (Ley 789/2002 art. 30).';
  }
  if (e.salaryType === 'integral') {
    return `Tiene salario integral, que ya incluye la ${NOMBRE_PRESTACION[p.tipo]} (art. 132 CST num. 2): no se paga aparte.`;
  }
  if (e.hireDate && /^\d{4}-\d{2}-\d{2}$/.test(e.hireDate) && p.periodoHasta < e.hireDate) {
    return `El periodo termina el ${p.periodoHasta}, antes de su ingreso (${e.hireDate}).`;
  }
  return null;
}

/**
 * La liquidación de retiro aprobada ya paga las cesantías y los intereses del
 * año del retiro (desde el 1 de enero) y la prima del semestre del retiro. Un
 * pago que cubra ese mismo tramo lo pagaría dos veces. Devuelve el motivo o null.
 */
export function motivoCruceConLiquidacion(
  p: { tipo: TipoPrestacion; periodoHasta: string },
  fechaRetiro: string | undefined,
): string | null {
  if (!fechaRetiro) return null;
  const anio = fechaRetiro.slice(0, 4);
  const inicio = p.tipo === 'prima' ? (semestreDe(fechaRetiro) === 1 ? `${anio}-01-01` : `${anio}-07-01`) : `${anio}-01-01`;
  if (p.periodoHasta < inicio) return null;
  return `El empleado tiene una liquidación de retiro aprobada (retiro el ${fechaRetiro}) que ya paga la ${NOMBRE_PRESTACION[p.tipo]} causada desde el ${inicio}. Registra aquí solo lo de periodos anteriores.`;
}

/** Suma `dias` a una fecha YYYY-MM-DD. */
const masDias = (fecha: string, dias: number): string => {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/**
 * Avisos que NO bloquean: el pago ya ocurrió y se registra tal cual, pero se
 * deja dicho lo que conviene revisar con el contador.
 */
export function avisosPagoPrestacion(p: PagoPrestacionEntrada): string[] {
  const avisos: string[] = [];
  const tipo = p.tipo as TipoPrestacion;
  const anio = Number(p.periodoHasta.slice(0, 4));
  if (tipo === 'prima') {
    const limite = semestreDe(p.periodoHasta) === 1 ? `${anio}-06-30` : `${anio}-12-20`;
    if (p.fechaPago > limite) {
      avisos.push(
        `La prima de este semestre debía pagarse a más tardar el ${limite} (art. 306 CST) y se pagó el ${p.fechaPago}. Se registra con la fecha real.`,
      );
    }
    avisos.push(
      'La retención en la fuente sobre la prima se calcula aparte de los demás pagos del mes (art. 385 ET, procedimiento 1) y BookiPos no la calcula: si correspondía, regístrala en este pago; confírmalo con el contador.',
    );
  }
  if (tipo === 'cesantias') {
    const limite = `${anio + 1}-02-14`;
    if (p.destino !== 'trabajador' && p.fechaPago > limite) {
      avisos.push(
        `Las cesantías de ${anio} debían consignarse al fondo a más tardar el ${limite} y se consignaron el ${p.fechaPago}: la mora causa un día de salario por cada día de retardo (Ley 50/1990 art. 99 num. 3). Revísalo con el contador.`,
      );
    }
    if (p.destino === 'trabajador') {
      avisos.push(
        'Las cesantías se entregaron al trabajador y no al fondo. Fuera de la terminación del contrato y de los retiros parciales autorizados, el pago directo está prohibido y el empleador puede perder lo pagado (art. 254 CST). Confírmalo con el contador.',
      );
    }
  }
  if (tipo === 'intereses_cesantias') {
    const limite = `${anio + 1}-01-31`;
    if (p.fechaPago > limite) {
      avisos.push(
        `Los intereses de las cesantías de ${anio} debían pagarse a más tardar el ${limite} y se pagaron el ${p.fechaPago}: la mora causa una indemnización igual a los intereses (Ley 52/1975 art. 1 num. 3). Revísalo con el contador.`,
      );
    }
  }
  // Un pago muy anterior al corte del tramo (un anticipo) merece una segunda mirada.
  if (p.fechaPago < masDias(p.periodoHasta, -45)) {
    avisos.push(
      `El pago (${p.fechaPago}) es más de 45 días anterior al fin del periodo que cubre (${p.periodoHasta}). Revisa las fechas: la nómina electrónica lo reporta en ${p.fechaPago.slice(0, 7)}.`,
    );
  }
  return avisos;
}
