/**
 * Consolidador de nómina electrónica: de las liquidaciones de BookiPos
 * (`PayrollRun.slips`) al `DocumentoNe` de UN trabajador en UN mes, con un
 * pre-vuelo que bloquea POR TRABAJADOR (no el mes entero).
 *
 * Fuente del mapeo: `documentacion/fe-fase8-anexo-nomina.md`. Es puro: recibe
 * las filas ya leídas (corridas, empleado, deducciones aplicadas, emisor) y no
 * toca la base. Los endpoints y la persistencia van en el PR de emisión.
 *
 * Qué entra: básico (días), auxilio de transporte, horas extra y recargos (con
 * su cantidad y su % de recargo), bonificaciones, comisiones, salud, pensión,
 * FSP (solidaridad 0,5 % + subsistencia), retención en la fuente y las
 * deducciones de nómina (`sale`/`arrastre` → Deuda; `manual` → OtraDeduccion).
 * Qué NO entra: aportes del empleador y provisiones (no son pagos al
 * trabajador). Retiro: la liquidación APROBADA del mes aporta cesantías,
 * intereses, prima, vacaciones compensadas e indemnización (decisión 4 del
 * dueño); sin ella, quien se retira en el mes se bloquea. Vacaciones,
 * incapacidades, licencias y el pago semestral de prima o la consignación de
 * cesantías no se inventan: si aparecen en la colilla, el trabajador se bloquea.
 *
 * Pago: el medio y la fecha REAL de cada egreso los declara el negocio al
 * cerrar la corrida (`PayrollRun.pago`, decisión 1 del dueño, tarea 11). Una
 * corrida cerrada sin ellos bloquea al trabajador; no se inventa fecha.
 * Empleador: el NIT del emisor de la sede del trabajador (decisión 6); lo
 * resuelve `NominaPeriodoService`.
 *
 * Dinero: las colillas están en COP entero; se suman con `sumCop()` y se pasan
 * a centavos con `centavosDeCop()`. El modelo no lleva totales: el armador los
 * recalcula sumando los nodos que escribe.
 */
import { cop, redondearA, sumCop } from '../../../finance/domain/money.util';
import { DANE_MUNICIPIO, YYYYMMDD } from '../../../employees/domain/employees.constants';
import type { PayrollBreakdown } from '../../../payroll/domain/payroll-calc';
import { MEDIOS_PAGO_NOMINA, NOMBRE_MEDIO_PAGO } from '../../../payroll/domain/pago-nomina';
import type { Centavos } from '../redondeo';
import { centavosDeCop } from '../redondeo';
import type { DeduccionesNe, DevengadosNe, DocumentoNe, HoraNe, TipoHoraNe } from './modelo';

// ── Entradas ─────────────────────────────────────────────────────────────────

const PENDIENTE_DUENO = 'pendiente de decisión del dueño (tarea 11)';

/** Lo que el consolidador lee de la colilla (`PayrollSlip`). */
export interface ColillaConsolidar {
  employeeId: string;
  employeeName?: string;
  diasTrabajados: number;
  salaryType?: string;
  breakdown: PayrollBreakdown;
  otrasDeduccionesDetalle?: { concept: string; amount: number; source?: string }[];
}

/** Una colilla con los datos de la corrida que la contiene. */
export interface CorridaColilla {
  corridaId: string;
  /** YYYY-MM */
  periodo: string;
  cobertura: 'all' | 'sede';
  sedeId?: string;
  estado: 'borrador' | 'cerrada';
  /** Tramo del mes que cubre la corrida (quincena o corrida parcial); sin él se asume el mes entero. */
  rango?: { desde: string; hasta: string };
  /** Medio (código DIAN 5.3.3.2) y fecha real del pago que el negocio declaró al cerrar la corrida (decisión 1 del dueño). */
  pago?: PagoCorrida;
  colilla: ColillaConsolidar;
}

export interface PagoCorrida {
  medio: string;
  /** YYYY-MM-DD */
  fecha: string;
}

/** Lo que se lee de `PayrollDeduction`. `appliedRunId` en texto. */
export interface DeduccionConsolidar {
  employeeId: string;
  concept: string;
  amount: number;
  source: string;
  status?: string;
  appliedRunId?: string;
}

/** Lo que se lee del expediente (`Employee`); `accountNumber` es el crudo, no el enmascarado. */
export interface EmpleadoConsolidar {
  id: string;
  docType?: string;
  docNumber?: string;
  firstName?: string;
  lastName?: string;
  secondLastName?: string;
  otherNames?: string;
  docTypeDian?: string;
  tipoTrabajador?: string;
  subTipoTrabajador?: string;
  altoRiesgoPension?: boolean;
  contractType?: string;
  tipoContratoDian?: string;
  hireDate?: string;
  terminationDate?: string;
  salary?: number;
  salaryType?: string;
  municipioDaneTrabajo?: string;
  direccionTrabajo?: string;
  address?: string;
  /** Ya no manda: el medio lo declara el negocio al cerrar la corrida. Se conserva por compatibilidad del expediente. */
  medioPago?: string;
  bank?: string;
  accountType?: string;
  accountNumber?: string;
}

/** El emisor fiscal de la sede (`FiscalEmitter`): respaldo de municipio y dirección del lugar de trabajo. */
export interface EmpleadorConsolidar {
  razonSocial?: string;
  municipioDane?: string;
  direccion?: string;
}

/** La liquidación de retiro APROBADA (`PayrollLiquidacion`), en pesos. */
export interface LiquidacionConsolidar {
  id: string;
  /** YYYY-MM-DD */
  fechaRetiro: string;
  diasLiquidados: number;
  /** Días del semestre que paga la prima. */
  diasPrima?: number;
  /** Días hábiles de vacaciones pendientes (causados menos disfrutados) que paga la liquidación. */
  diasVacacionesPendientes?: number;
  /** Salario mensual con que se liquidó (para el aviso de retención de cesantías, art. 206-4 ET). */
  salarioBase?: number;
  cesantias: number;
  interesesCesantias: number;
  prima: number;
  vacaciones: number;
  indemnizacion: number;
  salariosPendientes: number;
  pago?: PagoCorrida;
}

export interface EntradaConsolidar {
  /** YYYY-MM */
  periodo: string;
  empleado: EmpleadoConsolidar;
  empleador: EmpleadorConsolidar;
  slips: CorridaColilla[];
  deducciones: DeduccionConsolidar[];
  /** SMMLV vigente en el mes: sin él no se valida el mínimo del salario integral (13 SMMLV, art. 132 CST). */
  smmlv?: number;
  /** Liquidación de retiro aprobada cuyo retiro cae en el mes. */
  liquidacion?: LiquidacionConsolidar;
  /** UVT vigente (pesos): para el aviso de retención sobre cesantías. */
  uvt?: number;
}

/** Lo que se dejó de reportar por neto negativo (pesos): la parte de cada colilla que `crearArrastres` lleva al mes siguiente. */
export interface RecorteNeto {
  otras: number;
  deuda: number;
  total: number;
}

export type ResultadoConsolidar =
  | { ok: true; modelo: DocumentoNe; advertencias: string[]; recorte: RecorteNeto }
  | { ok: false; bloqueos: string[] };

// ── Catálogos ────────────────────────────────────────────────────────────────

/** `recargoDetalle.key` de BookiPos → tipo de hora de la nómina electrónica. */
const TIPO_POR_CLAVE: Record<string, TipoHoraNe> = {
  extraDiurna: 'HED',
  extraNocturna: 'HEN',
  recargoNocturno: 'HRN',
  extraDiurnaDominical: 'HEDDF',
  dominical: 'HRDDF',
  extraNocturnaDominical: 'HENDF',
  nocturnoDominical: 'HRNDF',
};

const DIAN_DOC_POR_DOCTYPE: Record<string, string> = {
  CC: '13',
  CE: '22',
  TI: '12',
  PA: '41',
  PEP: '47',
  NIT: '31',
};

/** `contractType` → códigos DIAN admitidos (aprendizaje: 4 lectiva o 5 prácticas). */
const CONTRATO_DIAN_POR_TIPO: Record<string, string[]> = {
  fijo: ['1'],
  indefinido: ['2'],
  obra_labor: ['3'],
  aprendizaje: ['4', '5'],
};

const DEVENGADOS_CONOCIDOS = new Set([
  'salario',
  'auxilioTransporte',
  'recargos',
  'horasExtra',
  'recargoDetalle',
  'bonificacionSalarial',
  'bonificacionNoSalarial',
  'comisiones',
  'total',
]);

const MEDIO_TRANSFERENCIA = '47';
const MEDIO_CONSIGNACION = '42';
const NOMBRE_MEDIO: Record<string, string> = NOMBRE_MEDIO_PAGO;
/** Mínimo del salario integral en SMMLV (art. 132 CST). */
const SMMLV_INTEGRAL = 13;
const FSP_SOLIDARIDAD_PCT = 0.5;

// ── Utilidades ───────────────────────────────────────────────────────────────

const pct2 = (v: number): number => redondearA(v, 2);

function ultimoDiaDelMes(periodo: string): string {
  const y = Number(periodo.slice(0, 4));
  const m = Number(periodo.slice(5, 7));
  return `${periodo}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** Antigüedad con años de 360 y meses de 30, contando ambos extremos (anexo §8.3.1). */
export function tiempoLaborado360(desde: string, hasta: string): number {
  const [y1, m1, d1] = desde.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = hasta.split('-').map(Number) as [number, number, number];
  // El último día de cualquier mes (también febrero) cuenta como 30.
  const dia360 = (fecha: string, d: number) => (fecha === ultimoDiaDelMes(fecha.slice(0, 7)) ? 30 : Math.min(d, 30));
  return Math.max(1, (y2 - y1) * 360 + (m2 - m1) * 30 + (dia360(hasta, d2) - dia360(desde, d1)) + 1);
}

const enteroPositivo = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function nombreDe(e: EmpleadoConsolidar): string {
  return `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim() || e.docNumber || e.id;
}

/** Dos tramos de fechas YYYY-MM-DD se cruzan si ninguno termina antes de que empiece el otro. */
const seCruzan = (a: { desde: string; hasta: string }, b: { desde: string; hasta: string }) =>
  a.desde <= b.hasta && b.desde <= a.hasta;

/** Dos corridas del mismo mes cubren al mismo trabajador a la vez (el estudio, §5: se bloquea, no se suma). */
function corridasSolapadas(a: CorridaColilla, b: CorridaColilla, mes: { desde: string; hasta: string }): boolean {
  if (a.corridaId === b.corridaId) return false;
  if (!seCruzan(a.rango ?? mes, b.rango ?? mes)) return false;
  const hayTodas = a.cobertura === 'all' || b.cobertura === 'all';
  return hayTodas || (a.sedeId ?? '') === (b.sedeId ?? '');
}

// ── Pre-vuelo del trabajador ─────────────────────────────────────────────────

function revisarTrabajador(
  e: EmpleadoConsolidar,
  periodo: string,
  medio: string | undefined,
  smmlv: number | undefined,
  liq: LiquidacionConsolidar | undefined,
  bloqueos: string[],
): void {
  const quien = nombreDe(e);
  const ficha = `Corrígelo en el expediente de ${quien} (Empleados → Nómina electrónica)`;
  const doc = (e.docNumber ?? '').trim();

  if (!e.docTypeDian) {
    bloqueos.push(`${quien}: falta el tipo de documento DIAN. ${ficha}.`);
  } else if (e.docTypeDian === '31') {
    bloqueos.push(
      `${quien}: el tipo de documento DIAN es 31 (NIT) y un trabajador no tiene NIT. ${ficha} con su cédula u otro documento personal.`,
    );
  } else if (e.docType && DIAN_DOC_POR_DOCTYPE[e.docType] && DIAN_DOC_POR_DOCTYPE[e.docType] !== e.docTypeDian) {
    bloqueos.push(
      `${quien}: el tipo de documento (${e.docType}) no coincide con el código DIAN ${e.docTypeDian} (debería ser ${DIAN_DOC_POR_DOCTYPE[e.docType]}). ${ficha}.`,
    );
  }
  if (!/^\d+$/.test(doc)) {
    bloqueos.push(
      `${quien}: el número de documento «${doc}» no es numérico y la DIAN lo recibe como entero. ${ficha} solo con dígitos, sin puntos ni letras.`,
    );
  }
  if (!e.tipoTrabajador) bloqueos.push(`${quien}: falta el tipo de trabajador DIAN (01 = dependiente). ${ficha}.`);
  if (!e.subTipoTrabajador) {
    bloqueos.push(`${quien}: falta el subtipo de trabajador DIAN (00 = no aplica). ${ficha}.`);
  }

  if (e.contractType === 'prestacion_servicios') {
    bloqueos.push(
      `${quien}: tiene contrato de prestación de servicios y el contratista no lleva nómina electrónica (no es una relación laboral). Quítalo de la corrida o corrige el tipo de contrato en su expediente.`,
    );
  } else if (!e.tipoContratoDian) {
    bloqueos.push(`${quien}: falta el tipo de contrato DIAN. ${ficha}.`);
  } else if (e.contractType && CONTRATO_DIAN_POR_TIPO[e.contractType]) {
    const validos = CONTRATO_DIAN_POR_TIPO[e.contractType]!;
    if (!validos.includes(e.tipoContratoDian)) {
      bloqueos.push(
        `${quien}: el tipo de contrato (${e.contractType}) no coincide con el código DIAN ${e.tipoContratoDian} (debería ser ${validos.join(' o ')}). ${ficha}.`,
      );
    }
  }

  if (!e.hireDate || !YYYYMMDD.test(e.hireDate)) {
    bloqueos.push(`${quien}: falta la fecha de ingreso (o no es YYYY-MM-DD). ${ficha}.`);
  } else if (e.hireDate > ultimoDiaDelMes(periodo)) {
    bloqueos.push(`${quien}: la fecha de ingreso ${e.hireDate} es posterior al mes ${periodo}. Corrígela en su expediente.`);
  }

  if (!enteroPositivo(e.salary)) bloqueos.push(`${quien}: falta el salario mensual pactado. ${ficha}.`);

  if (e.salaryType === 'integral' && enteroPositivo(e.salary) && enteroPositivo(smmlv) && e.salary < SMMLV_INTEGRAL * smmlv) {
    bloqueos.push(
      `${quien}: tiene salario integral de ${e.salary} y el mínimo es ${SMMLV_INTEGRAL} SMMLV (${SMMLV_INTEGRAL * smmlv}, art. 132 CST). Corrige el salario o el tipo de salario en su expediente.`,
    );
  }
  if (medio === MEDIO_TRANSFERENCIA) {
    const faltan = [
      !e.bank?.trim() && 'banco',
      !e.accountType && 'tipo de cuenta',
      !e.accountNumber?.trim() && 'número de cuenta',
    ].filter(Boolean);
    if (faltan.length > 0) {
      bloqueos.push(
        `${quien}: la nómina se pagó por transferencia y en su expediente falta ${faltan.join(', ')}. ${ficha}.`,
      );
    }
  }

  const retiroEnMes = !!e.terminationDate && e.terminationDate.slice(0, 7) === periodo;
  if (retiroEnMes && !liq) {
    bloqueos.push(
      `${quien}: se retira en ${periodo} (${e.terminationDate}) y no tiene liquidación de retiro aprobada. Guárdala y apruébala en Nómina → Liquidación; sin ella el documento saldría sin cesantías, prima ni vacaciones.`,
    );
  } else if (liq && liq.fechaRetiro !== e.terminationDate) {
    bloqueos.push(
      `${quien}: la liquidación aprobada es de un retiro el ${liq.fechaRetiro} y el expediente dice ${e.terminationDate ?? 'sin fecha de retiro'}. Corrige una de las dos.`,
    );
  }
}

// ── Revisión de cada colilla ────────────────────────────────────────────────

function revisarColilla(c: CorridaColilla, quien: string, bloqueos: string[]): boolean {
  const b = c.colilla.breakdown;
  const dev = b.devengados;
  const ded = b.deducciones;
  const donde = `${quien} (corrida ${c.corridaId})`;
  const antes = bloqueos.length;

  for (const [clave, valor] of Object.entries(dev as unknown as Record<string, unknown>)) {
    if (!DEVENGADOS_CONOCIDOS.has(clave) && typeof valor === 'number' && valor > 0) {
      bloqueos.push(
        `${donde}: la colilla trae el concepto «${clave}» (prima, cesantías, vacaciones, incapacidad, licencia, retiro u otro) y aún no se reporta: ${PENDIENTE_DUENO}.`,
      );
    }
  }
  for (const l of dev.recargoDetalle ?? []) {
    if (!TIPO_POR_CLAVE[l.key]) {
      bloqueos.push(`${donde}: tipo de hora «${l.key}» sin equivalente en la nómina electrónica: ${PENDIENTE_DUENO}.`);
    }
  }

  const sumaDev = sumCop([
    dev.salario,
    dev.auxilioTransporte,
    dev.recargos,
    dev.horasExtra,
    dev.bonificacionSalarial,
    dev.bonificacionNoSalarial,
    dev.comisiones,
  ]);
  if (sumaDev !== cop(dev.total)) {
    bloqueos.push(`${donde}: los devengados no cuadran entre sí (${sumaDev} ≠ ${dev.total}). Revisa o recalcula la corrida.`);
  }
  const pagoHoras = sumCop((dev.recargoDetalle ?? []).map((l) => l.valor));
  if (pagoHoras !== cop(dev.recargos + dev.horasExtra)) {
    bloqueos.push(
      `${donde}: el detalle de horas (${pagoHoras}) no cuadra con recargos + horas extra (${cop(dev.recargos + dev.horasExtra)}). Revisa o recalcula la corrida.`,
    );
  }
  const sumaDed = sumCop([ded.salud, ded.pension, ded.fsp, ded.retencionFuente, ded.otras]);
  if (sumaDed !== cop(ded.total)) {
    bloqueos.push(`${donde}: las deducciones no cuadran entre sí (${sumaDed} ≠ ${ded.total}). Revisa o recalcula la corrida.`);
  }
  const detalle = sumCop((c.colilla.otrasDeduccionesDetalle ?? []).map((d) => d.amount));
  if (detalle !== cop(ded.otras)) {
    bloqueos.push(
      `${donde}: el detalle de otras deducciones (${detalle}) no suma lo descontado (${ded.otras}). Revisa o recalcula la corrida.`,
    );
  }
  const importes: [string, number][] = [
    ['salario', dev.salario],
    ['auxilio de transporte', dev.auxilioTransporte],
    ['recargos', dev.recargos],
    ['horas extra', dev.horasExtra],
    ['bonificación salarial', dev.bonificacionSalarial],
    ['bonificación no salarial', dev.bonificacionNoSalarial],
    ['comisiones', dev.comisiones],
    ['total devengado', dev.total],
    ['IBC', b.ibc],
    ['salud', ded.salud],
    ['pensión', ded.pension],
    ['FSP', ded.fsp],
    ['retención en la fuente', ded.retencionFuente],
    ['otras deducciones', ded.otras],
    ['total deducciones', ded.total],
    ...(dev.recargoDetalle ?? []).map((l): [string, number] => [`horas ${l.key}`, l.valor]),
    ...(c.colilla.otrasDeduccionesDetalle ?? []).map((d): [string, number] => [`deducción «${d.concept}»`, d.amount]),
  ];
  const malos = importes.filter(([, v]) => !Number.isInteger(v) || v < 0).map(([k, v]) => `${k} (${String(v)})`);
  if (malos.length > 0) {
    bloqueos.push(`${donde}: importes que no son pesos enteros no negativos: ${malos.join(', ')}. Revisa o recalcula la corrida.`);
  }
  if (!Number.isInteger(c.colilla.diasTrabajados) || c.colilla.diasTrabajados < 0) {
    bloqueos.push(`${donde}: los días trabajados (${c.colilla.diasTrabajados}) deben ser un entero no negativo.`);
  }
  return bloqueos.length === antes;
}

/** Clasifica cada deducción de la colilla: Deuda (fiado y arrastre) u OtraDeduccion (manual). */
function clasificarDeducciones(
  c: CorridaColilla,
  deducciones: DeduccionConsolidar[],
  advertir: (m: string) => void,
): { deuda: number; otras: number[]; arrastre: number } {
  const propias = deducciones.filter(
    (d) => d.appliedRunId === c.corridaId && d.employeeId === c.colilla.employeeId && d.status !== 'cancelled',
  );
  const usadas = new Set<DeduccionConsolidar>();
  let deuda = 0;
  let arrastre = 0;
  const otras: number[] = [];
  for (const det of c.colilla.otrasDeduccionesDetalle ?? []) {
    // Mismo concepto y monto; entre los candidatos manda el que tiene el mismo origen que dice la colilla.
    const candidatos = propias.filter((d) => !usadas.has(d) && d.concept === det.concept && d.amount === det.amount);
    const par = candidatos.find((d) => det.source && d.source === det.source) ?? candidatos[0];
    if (par) usadas.add(par);
    else if (!det.source) {
      advertir(
        `Corrida ${c.corridaId}: la deducción «${det.concept}» (${det.amount}) no se pudo vincular a ninguna deducción aplicada; se reporta como OtraDeduccion. Si era un consumo o fiado, debería ir como Deuda: revísala.`,
      );
    }
    const fuente = par?.source ?? det.source ?? 'manual';
    if (fuente === 'sale') deuda += det.amount;
    else if (fuente === 'arrastre') {
      deuda += det.amount;
      arrastre += det.amount;
    } else otras.push(det.amount);
  }
  return { deuda, otras, arrastre };
}

/** Tasa de los intereses de cesantías (Ley 52 de 1975): `Cesantias@Porcentaje`. */
const INTERESES_CESANTIAS_PCT = 12;
/**
 * Salario mensual promedio por encima del cual las cesantías y sus intereses
 * dejan de ser exentos del todo (art. 206 num. 4 ET), en UVT.
 * A CONFIRMAR con el contador: tope vigente y si se mide con el promedio de los últimos 6 meses.
 */
const TOPE_CESANTIAS_EXENTAS_UVT = 350;

/**
 * Nodos del retiro (anexo §3): Cesantias (pago, 12.00, intereses), Primas
 * (días del semestre), VacacionesCompensadas (días = días liquidados × 15 /
 * 360) e Indemnizacion. El último sueldo NO va aquí: va en la colilla del mes.
 */
function agregarLiquidacion(
  d: DevengadosNe,
  liq: LiquidacionConsolidar,
  quien: string,
  bloqueos: string[],
  advertencias: string[],
  uvt: number | undefined,
): void {
  const importes: [string, number][] = [
    ['cesantías', liq.cesantias],
    ['intereses de cesantías', liq.interesesCesantias],
    ['prima', liq.prima],
    ['vacaciones', liq.vacaciones],
    ['indemnización', liq.indemnizacion],
    ['salarios pendientes', liq.salariosPendientes],
  ];
  const malos = importes.filter(([, v]) => !Number.isInteger(v) || v < 0).map(([k, v]) => `${k} (${String(v)})`);
  if (malos.length > 0) {
    bloqueos.push(`${quien}: la liquidación de retiro trae importes que no son pesos enteros no negativos: ${malos.join(', ')}.`);
    return;
  }
  if (liq.salariosPendientes > 0) {
    bloqueos.push(
      `${quien}: la liquidación de retiro trae ${liq.salariosPendientes} de salarios pendientes; el último sueldo va en la nómina del mes, con salud y pensión. Anúlala y guárdala de nuevo sin ese valor.`,
    );
    return;
  }
  if (liq.cesantias > 0 || liq.interesesCesantias > 0) {
    d.cesantias = {
      pago: centavosDeCop(liq.cesantias),
      porcentaje: INTERESES_CESANTIAS_PCT,
      intereses: centavosDeCop(liq.interesesCesantias),
    };
  }
  if (liq.prima > 0) {
    if (!Number.isInteger(liq.diasPrima) || (liq.diasPrima ?? 0) <= 0) {
      bloqueos.push(`${quien}: la liquidación de retiro no trae los días del semestre de la prima. Anúlala y guárdala de nuevo.`);
      return;
    }
    d.primas = { dias: liq.diasPrima!, pago: centavosDeCop(liq.prima) };
  }
  if (liq.vacaciones > 0) {
    // Los días que se pagan: causados (15 por año, art. 186 CST) menos los ya disfrutados (art. 189).
    // Con pago, al menos 1 día. Las compensadas no son base de salud ni pensión (art. 192 CST):
    // a confirmar con concepto UGPP vigente.
    const pendientes = liq.diasVacacionesPendientes;
    if (typeof pendientes !== 'number' || !Number.isFinite(pendientes) || pendientes < 0) {
      bloqueos.push(
        `${quien}: la liquidación de retiro no trae los días de vacaciones pendientes (causados menos disfrutados). Anúlala y guárdala de nuevo.`,
      );
      return;
    }
    d.vacacionesCompensadas = [{ dias: Math.max(1, Math.round(pendientes)), pago: centavosDeCop(liq.vacaciones) }];
  }
  if (liq.indemnizacion > 0) {
    d.indemnizacion = centavosDeCop(liq.indemnizacion);
    advertencias.push(
      `${quien}: la indemnización (${liq.indemnizacion}) puede llevar retención en la fuente (art. 401-3 ET) y BookiPos no la calcula. Confírmalo con el contador antes de emitir.`,
    );
  }
  const salario = liq.salarioBase ?? 0;
  if (liq.cesantias + liq.interesesCesantias > 0 && enteroPositivo(uvt) && salario > TOPE_CESANTIAS_EXENTAS_UVT * uvt) {
    advertencias.push(
      `${quien}: con salario de ${salario} (más de ${TOPE_CESANTIAS_EXENTAS_UVT} UVT) las cesantías e intereses no son exentos del todo (art. 206 num. 4 ET) y BookiPos no calcula esa retención. Confírmalo con el contador.`,
    );
  }
}

// ── Consolidación ───────────────────────────────────────────────────────────

export function consolidarNominaMes(entrada: EntradaConsolidar): ResultadoConsolidar {
  const { periodo, empleado: e, empleador } = entrada;
  const bloqueos: string[] = [];
  const advertencias: string[] = [];
  const quien = nombreDe(e);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    return { ok: false, bloqueos: [`El periodo «${periodo}» no es un mes YYYY-MM.`] };
  }
  const primero = `${periodo}-01`;
  const ultimo = ultimoDiaDelMes(periodo);

  // Corridas del trabajador en el mes.
  const delMes = entrada.slips.filter((s) => s.periodo === periodo && s.colilla.employeeId === e.id);
  const cerradas = delMes.filter((s) => s.estado === 'cerrada');
  const borradores = delMes.filter((s) => s.estado !== 'cerrada');
  if (borradores.length > 0) {
    bloqueos.push(`${quien}: la corrida de ${periodo} sigue en borrador. Ciérrala antes de generar la nómina electrónica.`);
  }
  if (cerradas.length === 0) {
    if (borradores.length === 0) {
      bloqueos.push(`${quien}: no tiene ninguna corrida cerrada en ${periodo}; sin pagos en el mes no hay documento.`);
    }
    revisarTrabajador(e, periodo, undefined, entrada.smmlv, entrada.liquidacion, bloqueos);
    return { ok: false, bloqueos };
  }

  // Medio y fecha real del pago: los declara el negocio al cerrar cada corrida (decisión 1 del dueño); sin ellos no se consolida.
  const finMesSiguiente = ultimoDiaDelMes(
    new Date(Date.UTC(Number(periodo.slice(0, 4)), Number(periodo.slice(5, 7)), 1)).toISOString().slice(0, 7),
  );
  /** Cada egreso con lo que se pagó en él (pesos), para elegir el medio del nodo Pago. */
  const pagos: (PagoCorrida & { valor: number })[] = [];
  for (const c of cerradas) {
    const p = c.pago;
    if (!p?.medio || !p.fecha) {
      bloqueos.push(
        `${quien}: la corrida ${c.corridaId} de ${periodo} no tiene declarado ${[!p?.medio && 'el medio de pago', !p?.fecha && 'la fecha real de pago'].filter(Boolean).join(' ni ')}. Decláralo en Nómina → la corrida → «Pago de la nómina».`,
      );
    } else if (!(MEDIOS_PAGO_NOMINA as readonly string[]).includes(p.medio)) {
      bloqueos.push(`${quien}: la corrida ${c.corridaId} declara un medio de pago «${p.medio}» que no es válido para nómina (efectivo, cheque, consignación o transferencia).`);
    } else if (!YYYYMMDD.test(p.fecha)) {
      bloqueos.push(`${quien}: la fecha de pago de la corrida ${c.corridaId} («${p.fecha}») no es YYYY-MM-DD.`);
    } else if (p.fecha < primero) {
      bloqueos.push(`${quien}: la fecha de pago de la corrida ${c.corridaId} (${p.fecha}) es anterior al inicio de ${periodo}. Corrígela en la corrida.`);
    } else {
      if (p.fecha > finMesSiguiente) {
        advertencias.push(`${quien}: la corrida ${c.corridaId} se pagó el ${p.fecha}, después del mes siguiente a ${periodo}; confírmalo.`);
      }
      const bd = c.colilla.breakdown;
      pagos.push({ ...p, valor: Math.max(0, cop(bd.devengados.total) - cop(bd.deducciones.total)) });
    }
  }
  // La liquidación del retiro es otro egreso: su pago también va al documento.
  const liq = entrada.liquidacion;
  if (liq) {
    const p = liq.pago;
    if (!p?.medio || !p.fecha || !(MEDIOS_PAGO_NOMINA as readonly string[]).includes(p.medio) || !YYYYMMDD.test(p.fecha)) {
      bloqueos.push(
        `${quien}: la liquidación de retiro aprobada no tiene un medio y una fecha de pago válidos. Anúlala y apruébala de nuevo con esos datos.`,
      );
    } else if (p.fecha < primero) {
      bloqueos.push(`${quien}: la liquidación se pagó el ${p.fecha}, antes de ${periodo}. Corrígela.`);
    } else {
      const l = liq;
      pagos.push({ ...p, valor: sumCop([l.cesantias, l.interesesCesantias, l.prima, l.vacaciones, l.indemnizacion]) });
    }
  }
  // El XSD admite un solo nodo Pago: manda el medio por el que se pagó MÁS en el mes (con empate, el último).
  const porMedio = new Map<string, { valor: number; fecha: string }>();
  for (const p of pagos) {
    const m = porMedio.get(p.medio) ?? { valor: 0, fecha: '' };
    porMedio.set(p.medio, { valor: m.valor + p.valor, fecha: p.fecha > m.fecha ? p.fecha : m.fecha });
  }
  const medio = [...porMedio.entries()].sort(
    ([, a], [, b]) => b.valor - a.valor || b.fecha.localeCompare(a.fecha),
  )[0]?.[0];
  if (new Set(pagos.map((p) => p.medio)).size > 1) {
    advertencias.push(
      `${quien}: las corridas de ${periodo} se pagaron por medios distintos; el documento reporta el de mayor valor pagado (${NOMBRE_MEDIO[medio!] ?? medio}).`,
    );
  }
  revisarTrabajador(e, periodo, medio, entrada.smmlv, liq, bloqueos);

  const mes = { desde: primero, hasta: ultimo };
  const vistos = new Set<string>();
  for (const c of delMes) {
    if (vistos.has(c.corridaId)) {
      bloqueos.push(
        `${quien}: la colilla de la corrida ${c.corridaId} viene repetida en ${periodo}; sumarla dos veces duplicaría el pago. Revisa los datos de entrada.`,
      );
    }
    vistos.add(c.corridaId);
    const r = c.rango;
    if (r && !(YYYYMMDD.test(r.desde) && YYYYMMDD.test(r.hasta) && r.desde <= r.hasta && r.desde >= primero && r.hasta <= ultimo)) {
      bloqueos.push(`${quien}: el rango de la corrida ${c.corridaId} (${r.desde} a ${r.hasta}) no está dentro de ${periodo}.`);
    }
  }
  for (let i = 0; i < cerradas.length; i++) {
    for (let j = i + 1; j < cerradas.length; j++) {
      if (corridasSolapadas(cerradas[i]!, cerradas[j]!, mes)) {
        bloqueos.push(
          `${quien}: aparece en dos corridas cerradas de ${periodo} con coberturas que se solapan (${cerradas[i]!.cobertura} y ${cerradas[j]!.cobertura}); sumarlas duplicaría el pago. Elimina la corrida repetida o ajusta su cobertura.`,
        );
      }
    }
  }
  const colillasOk = cerradas.map((c) => revisarColilla(c, quien, bloqueos));
  if (bloqueos.length > 0 || colillasOk.some((ok) => !ok)) return { ok: false, bloqueos };

  // ── Devengados ──
  const colillas = cerradas.map((c) => c.colilla);
  const dias = colillas.reduce((s, c) => s + c.diasTrabajados, 0);
  if (dias > 30) {
    bloqueos.push(`${quien}: suma ${dias} días trabajados en ${periodo} y el mes comercial tiene 30. Revisa las corridas.`);
  }
  const sum = (pick: (b: PayrollBreakdown) => number): number => sumCop(colillas.map((c) => pick(c.breakdown)));

  const horasPorClave = new Map<string, HoraNe>();
  for (const col of colillas) {
    for (const l of col.breakdown.devengados.recargoDetalle ?? []) {
      const tipo = TIPO_POR_CLAVE[l.key]!;
      const porcentaje = pct2(l.factor * 100);
      const clave = `${tipo}|${porcentaje}`;
      const h = horasPorClave.get(clave) ?? { tipo, cantidad: 0, porcentaje, pago: 0 };
      h.cantidad = pct2(h.cantidad + l.horas);
      h.pago += centavosDeCop(l.valor);
      horasPorClave.set(clave, h);
    }
  }
  const ordenTipos: string[] = Object.values(TIPO_POR_CLAVE);
  const horas = [...horasPorClave.values()].sort(
    (a, b) => ordenTipos.indexOf(a.tipo) - ordenTipos.indexOf(b.tipo) || a.porcentaje - b.porcentaje,
  );

  const auxilio = sum((b) => b.devengados.auxilioTransporte);
  const bonS = sum((b) => b.devengados.bonificacionSalarial);
  const bonNS = sum((b) => b.devengados.bonificacionNoSalarial);
  const comisiones = sum((b) => b.devengados.comisiones);

  const devengados: DevengadosNe = {
    basico: { dias, sueldo: centavosDeCop(sum((b) => b.devengados.salario)) },
    ...(auxilio > 0 ? { transporte: { auxilio: centavosDeCop(auxilio) } } : {}),
    horas,
    vacacionesComunes: [],
    vacacionesCompensadas: [],
    incapacidades: [],
    licenciasMP: [],
    bonificaciones:
      bonS > 0 || bonNS > 0
        ? [{ ...(bonS > 0 ? { s: centavosDeCop(bonS) } : {}), ...(bonNS > 0 ? { ns: centavosDeCop(bonNS) } : {}) }]
        : [],
    auxilios: [],
    otrosConceptos: [],
    comisiones: comisiones > 0 ? [centavosDeCop(comisiones)] : [],
    pagosTerceros: [],
  };
  if (liq) {
    agregarLiquidacion(devengados, liq, quien, bloqueos, advertencias, entrada.uvt);
    // La colilla del mes no puede pagar días después del retiro: pasa si la corrida se cerró antes de aprobar
    // la liquidación (con el mes entero). No se reporta; la corrida cerrada no se recalcula, así que se corrige
    // con el contador (pago de más) y una nueva corrida o ajuste.
    if (e.hireDate && YYYYMMDD.test(e.hireDate)) {
      const desde = e.hireDate > primero ? e.hireDate : primero;
      const tope = liq.fechaRetiro >= desde ? tiempoLaborado360(desde, liq.fechaRetiro) : 0;
      if (dias > tope) {
        bloqueos.push(
          `${quien}: las corridas de ${periodo} le pagan ${dias} días y el retiro fue el ${liq.fechaRetiro} (${tope} días). La corrida se cerró antes del retiro: no se puede reportar así. Revísalo con el contador.`,
        );
      }
    }
  }

  // ── Deducciones ──
  const ibc = sum((b) => b.ibc);
  const salud = sum((b) => b.deducciones.salud);
  const pension = sum((b) => b.deducciones.pension);
  const fsp = sum((b) => b.deducciones.fsp);
  const retencion = sum((b) => b.deducciones.retencionFuente);

  if (e.subTipoTrabajador === '01' && pension > 0) {
    bloqueos.push(
      `${quien}: es pensionado por vejez activo (subtipo 01) y la nómina le descontó pensión (${pension}). Corrige la colilla (un pensionado no cotiza pensión) o el subtipo en su expediente.`,
    );
  }

  if (e.subTipoTrabajador === '01' && fsp > 0) {
    bloqueos.push(
      `${quien}: es pensionado por vejez activo (subtipo 01) y la nómina le descontó fondo de solidaridad pensional (${fsp}). Corrige la colilla o el subtipo en su expediente.`,
    );
  }
  if (fsp > 0 && ibc <= 0) {
    bloqueos.push(`${quien}: la nómina descontó FSP (${fsp}) con IBC en 0; no se puede derivar su porcentaje. Revisa la corrida.`);
  }

  // FSP: solidaridad 0,5 % del IBC y subsistencia el resto, colilla por colilla.
  let fspSol = 0;
  let fspSub = 0;
  for (const col of colillas) {
    const f = col.breakdown.deducciones.fsp;
    const sol = Math.min(f, cop(col.breakdown.ibc * (FSP_SOLIDARIDAD_PCT / 100)));
    fspSol += sol;
    fspSub += f - sol;
  }
  const porcentajeSalud = ibc > 0 ? pct2((salud / ibc) * 100) : 4;
  const porcentajePension = e.subTipoTrabajador === '01' ? 0 : ibc > 0 ? pct2((pension / ibc) * 100) : 4;
  // Pendiente: en corridas parciales la tarifa sale mezclada (Σ FSP / Σ IBC); lo exacto sería la tarifa de cada
  // colilla. Hoy no bloquea porque BookiPos liquida una corrida por mes.
  const tarifaFsp = ibc > 0 ? pct2((fsp / ibc) * 100) : 0;
  if (fspSub > 0 && pct2(tarifaFsp - FSP_SOLIDARIDAD_PCT) <= 0) {
    bloqueos.push(`${quien}: el FSP descontado (${fsp}) no alcanza para partirlo en solidaridad y subsistencia. Revisa la corrida.`);
  }

  const clasificadas = cerradas.map((c) => clasificarDeducciones(c, entrada.deducciones, (m) => advertencias.push(m)));

  // Neto negativo (estudio §2): lo reportado es lo que de verdad se descontó. `crearArrastres` lleva a la nómina
  // siguiente el saldo de CADA colilla con neto negativo (−netoPagar, sin importar el origen de la deducción,
  // también lo manual); allí sale como Deuda. Por eso el exceso se calcula por colilla y no con el mes sumado.
  // Se recortan primero las otras deducciones y luego la Deuda; salud, pensión, FSP y retención no se tocan.
  let deuda = 0;
  let otras: number[] = [];
  const recorte: RecorteNeto = { otras: 0, deuda: 0, total: 0 };
  cerradas.forEach((c, i) => {
    const bd = c.colilla.breakdown;
    const cl = clasificadas[i]!;
    let exceso = Math.max(0, cop(bd.deducciones.total) - cop(bd.devengados.total));
    const antes = sumCop(cl.otras) + cl.deuda;
    if (exceso > antes) {
      bloqueos.push(
        `${quien}: en la corrida ${c.corridaId} salud, pensión, FSP y retención superan lo devengado (${bd.devengados.total}); el comprobante no puede ser negativo y no hay deducciones de nómina que recortar. Revisa la corrida.`,
      );
      return;
    }
    const saldo = exceso;
    const otrasC = cl.otras.map((v) => {
      const r = Math.min(v, exceso);
      exceso -= r;
      return v - r;
    });
    const recOtras = sumCop(cl.otras) - sumCop(otrasC);
    otras = otras.concat(otrasC);
    deuda += cl.deuda - exceso;
    recorte.otras += recOtras;
    recorte.deuda += exceso;
    recorte.total += saldo;
    if (saldo > 0) {
      advertencias.push(
        `${quien}: la colilla de la corrida ${c.corridaId} tiene neto negativo (−${saldo}). Se reporta ${antes - saldo} de ${antes} en deducciones de nómina; el saldo de ${saldo} (otras deducciones: ${recOtras}, Deuda: ${saldo - recOtras}) lo lleva el sistema como arrastre al mes siguiente, donde sale como Deuda.`,
      );
    }
  });
  if (bloqueos.length > 0) return { ok: false, bloqueos };

  const deducciones: DeduccionesNe = {
    salud: { porcentaje: porcentajeSalud, valor: centavosDeCop(salud) },
    fondoPension: { porcentaje: porcentajePension, valor: centavosDeCop(pension) },
    ...(fsp > 0
      ? {
          fondoSP: {
            porcentaje: FSP_SOLIDARIDAD_PCT,
            valor: centavosDeCop(fspSol),
            ...(fspSub > 0
              ? { porcentajeSub: pct2(tarifaFsp - FSP_SOLIDARIDAD_PCT), valorSub: centavosDeCop(fspSub) }
              : {}),
          },
        }
      : {}),
    sindicatos: [],
    sanciones: [],
    libranzas: [],
    pagosTerceros: [],
    anticipos: [],
    otras: otras.filter((v) => v > 0).map(centavosDeCop),
    ...(retencion > 0 ? { retencionFuente: centavosDeCop(retencion) } : {}),
    ...(deuda > 0 ? { deuda: centavosDeCop(deuda) } : {}),
  };

  // ── Datos del trabajador y del pago ──
  const municipioPropio = e.municipioDaneTrabajo?.trim();
  const municipio = municipioPropio || empleador.municipioDane?.trim();
  if (!municipio || !DANE_MUNICIPIO.test(municipio)) {
    bloqueos.push(
      `${quien}: falta el municipio DANE del lugar de trabajo (5 dígitos) ni el emisor tiene uno válido. Complétalo en el expediente o en los datos fiscales del emisor.`,
    );
  } else if (!municipioPropio) {
    advertencias.push(`${quien}: sin municipio DANE propio; se usa el del emisor (${municipio}).`);
  }
  const direccion = (e.direccionTrabajo || e.address || empleador.direccion || '').trim();
  if (!direccion) {
    bloqueos.push(`${quien}: falta la dirección del lugar de trabajo (ni el expediente ni el emisor la tienen).`);
  }
  if (bloqueos.length > 0) return { ok: false, bloqueos };

  // Nombres: `lastName` es el primer apellido; si no hay segundo y viene «Pérez Gómez», se parte y se avisa.
  let primerApellido = (e.lastName ?? '').trim();
  let segundoApellido = (e.secondLastName ?? '').trim();
  if (!segundoApellido) {
    const partes = primerApellido.split(/\s+/).filter(Boolean);
    if (partes.length === 2) {
      [primerApellido, segundoApellido] = [partes[0]!, partes[1]!];
      advertencias.push(`${quien}: no tiene segundo apellido registrado; se partió el apellido. Confírmalo en el expediente.`);
    } else {
      advertencias.push(`${quien}: no tiene segundo apellido registrado; el documento lo lleva vacío.`);
    }
  }
  let primerNombre = (e.firstName ?? '').trim();
  let otrosNombres = (e.otherNames ?? '').trim();
  if (!otrosNombres) {
    const partes = primerNombre.split(/\s+/).filter(Boolean);
    if (partes.length > 1) {
      primerNombre = partes[0]!;
      otrosNombres = partes.slice(1).join(' ');
    }
  }

  const conCuenta = medio === MEDIO_TRANSFERENCIA || (medio === MEDIO_CONSIGNACION && !!e.accountNumber?.trim());
  // Una FechaPago por egreso: las fechas distintas de las corridas, en orden.
  const fechasPagos = [...new Set(pagos.map((p) => p.fecha))].sort();

  const desdeLiq = e.hireDate! > primero ? e.hireDate! : primero;
  const finLiq = liq && liq.fechaRetiro < ultimo ? liq.fechaRetiro : ultimo;
  const unaCorrida = cerradas.length === 1;
  const todasConRango = cerradas.every((c) => c.rango);
  const quincenales = todasConRango && cerradas.every((c) => c.rango!.hasta.slice(-2) <= '16' || c.rango!.desde.slice(-2) >= '16');
  const periodoNomina = unaCorrida ? '5' : quincenales ? '4' : '6';

  const modelo: DocumentoNe = {
    periodo: {
      fechaIngreso: e.hireDate!,
      ...(liq ? { fechaRetiro: liq.fechaRetiro } : {}),
      fechaLiquidacionInicio: desdeLiq,
      fechaLiquidacionFin: finLiq,
      tiempoLaborado: tiempoLaborado360(e.hireDate!, finLiq),
    },
    periodoNomina,
    trabajador: {
      tipoTrabajador: e.tipoTrabajador!,
      subTipoTrabajador: e.subTipoTrabajador!,
      altoRiesgoPension: e.altoRiesgoPension === true,
      tipoDocumento: e.docTypeDian!,
      numeroDocumento: (e.docNumber ?? '').trim(),
      primerApellido,
      segundoApellido,
      primerNombre,
      ...(otrosNombres ? { otrosNombres } : {}),
      lugarTrabajo: { departamento: municipio!.slice(0, 2), municipio: municipio!, direccion },
      salarioIntegral: e.salaryType === 'integral',
      tipoContrato: e.tipoContratoDian!,
      sueldo: centavosDeCop(e.salary!),
    },
    pago: {
      forma: '1',
      metodo: medio!,
      ...(conCuenta
        ? {
            banco: e.bank?.trim() || undefined,
            tipoCuenta: e.accountType,
            numeroCuenta: e.accountNumber?.trim() || undefined,
          }
        : {}),
    },
    fechasPagos,
    devengados,
    deducciones,
  };
  return { ok: true, modelo, advertencias, recorte };
}

/**
 * Suma en centavos de los valores que el armador escribiría; sirve para verificar el cuadre con las colillas.
 * `salariosPendientes` de la liquidación NO entra: el consolidador la bloquea, porque el último sueldo va en la
 * colilla del mes (Basico, con salud y pensión); sumarla aquí lo reportaría dos veces.
 */
export function totalesDeModelo(m: DocumentoNe): { devengados: Centavos; deducciones: Centavos } {
  const d = m.devengados;
  const dev =
    d.basico.sueldo +
    (d.transporte?.auxilio ?? 0) +
    d.horas.reduce((s, h) => s + h.pago, 0) +
    d.bonificaciones.reduce((s, b) => s + (b.s ?? 0) + (b.ns ?? 0), 0) +
    d.comisiones.reduce((s, v) => s + v, 0) +
    (d.cesantias ? d.cesantias.pago + d.cesantias.intereses : 0) +
    (d.primas?.pago ?? 0) +
    d.vacacionesCompensadas.reduce((s, v) => s + v.pago, 0) +
    (d.indemnizacion ?? 0);
  const x = m.deducciones;
  const ded =
    x.salud.valor +
    x.fondoPension.valor +
    (x.fondoSP?.valor ?? 0) +
    (x.fondoSP?.valorSub ?? 0) +
    x.otras.reduce((s, v) => s + v, 0) +
    (x.retencionFuente ?? 0) +
    (x.deuda ?? 0);
  return { devengados: dev, deducciones: ded };
}
