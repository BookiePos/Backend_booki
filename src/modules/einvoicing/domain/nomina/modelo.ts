import type { Centavos } from '../redondeo';

/**
 * Modelo del documento soporte de pago de nómina electrónica (anexo técnico
 * V1.0, XSD 1.0.6) de UN trabajador en UN mes, ya consolidado.
 *
 * Lo llena después un consolidador (otro PR) desde las tablas de nómina y
 * asistencia; `xml-nomina.ts` solo lo serializa. Reglas del modelo:
 *
 * - Todo el dinero va en centavos enteros no negativos (`Centavos`). Los
 *   totales NO viajan en el modelo: el armador los calcula sumando los nodos
 *   que escribe, para que no puedan descuadrar con ellos.
 * - Un valor en 0 o ausente no genera nodo (VLR01). Son obligatorios, aunque
 *   valgan 0: Basico, Salud y FondoPension.
 * - Cantidades (horas, días) y porcentajes son números normales, no dinero.
 */

/** Tipos de hora extra o recargo, en el orden en que los pide el XSD. */
export const TIPOS_HORA_NE = ['HED', 'HEN', 'HRN', 'HEDDF', 'HRDDF', 'HENDF', 'HRNDF'] as const;
export type TipoHoraNe = (typeof TIPOS_HORA_NE)[number];

/** Un par (tipo, porcentaje) del mes: horas sumadas y lo pagado por ellas. */
export interface HoraNe {
  tipo: TipoHoraNe;
  cantidad: number;
  /**
   * RECARGO de la tabla 5.5.7, NO el factor total: el consolidador entrega el
   * porcentaje que se suma a la hora ordinaria. HED 25.00, HEN 75.00, HRN 35.00;
   * HEDDF, HRDDF, HENDF y HRNDF con el porcentaje vigente en la fecha de las
   * horas (Ley 2466 de 2025, Oficio 13840/2025: p. ej. HRDDF 80.00 desde
   * 1-jul-2025 y 90.00 desde 1-jul-2026). El armador lo escribe tal cual.
   */
  porcentaje: number;
  pago: Centavos;
}

export interface DiasPagoNe {
  dias: number;
  pago: Centavos;
  /** YYYY-MM-DD. Obligatorias en vacaciones comunes y licencias. */
  fechaInicio?: string;
  fechaFin?: string;
}

export interface IncapacidadNe extends DiasPagoNe {
  /** 1 común, 2 profesional, 3 laboral. */
  tipo: 1 | 2 | 3;
}

/** Valor salarial (s) y no salarial (ns), ambos opcionales. */
export interface SalarialNe {
  s?: Centavos;
  ns?: Centavos;
}

export interface DevengadosNe {
  basico: { dias: number; sueldo: Centavos };
  transporte?: { auxilio?: Centavos; viaticoS?: Centavos; viaticoNS?: Centavos };
  horas: HoraNe[];
  vacacionesComunes: DiasPagoNe[];
  vacacionesCompensadas: DiasPagoNe[];
  primas?: { dias: number; pago: Centavos; pagoNS?: Centavos };
  /** `porcentaje` es la tasa de los intereses (12.00). */
  cesantias?: { pago: Centavos; porcentaje: number; intereses: Centavos };
  incapacidades: IncapacidadNe[];
  licenciasMP: DiasPagoNe[];
  bonificaciones: SalarialNe[];
  auxilios: SalarialNe[];
  otrosConceptos: (SalarialNe & { descripcion: string })[];
  comisiones: Centavos[];
  pagosTerceros: Centavos[];
  dotacion?: Centavos;
  indemnizacion?: Centavos;
  reintegro?: Centavos;
}

export interface DeduccionesNe {
  salud: { porcentaje: number; valor: Centavos };
  fondoPension: { porcentaje: number; valor: Centavos };
  /** Fondo de solidaridad y de subsistencia. */
  fondoSP?: { porcentaje: number; valor: Centavos; porcentajeSub?: number; valorSub?: Centavos };
  sindicatos: { porcentaje: number; valor: Centavos }[];
  /** Sanciones privadas; la pública va siempre en 0.00 (el XSD la exige). */
  sanciones: Centavos[];
  libranzas: { descripcion: string; valor: Centavos }[];
  pagosTerceros: Centavos[];
  anticipos: Centavos[];
  otras: Centavos[];
  pensionVoluntaria?: Centavos;
  retencionFuente?: Centavos;
  afc?: Centavos;
  cooperativa?: Centavos;
  embargoFiscal?: Centavos;
  planComplementarios?: Centavos;
  educacion?: Centavos;
  reintegro?: Centavos;
  deuda?: Centavos;
}

export interface TrabajadorNe {
  /** Tabla 5.5.3 (tipo de cotizante de la PILA). */
  tipoTrabajador: string;
  /** Tabla 5.5.4. */
  subTipoTrabajador: string;
  altoRiesgoPension: boolean;
  /** Tabla de tipos de documento (13 CC…). */
  tipoDocumento: string;
  /** Solo dígitos: el XSD lo recibe como entero. */
  numeroDocumento: string;
  primerApellido: string;
  segundoApellido: string;
  primerNombre: string;
  otrosNombres?: string;
  lugarTrabajo: { departamento: string; municipio: string; direccion: string };
  salarioIntegral: boolean;
  tipoContrato: string;
  /** Salario mensual pactado al cierre del mes (no el prorrateado). */
  sueldo: Centavos;
}

/** El contenido de UN trabajador en UN mes. */
export interface DocumentoNe {
  periodo: {
    /** YYYY-MM-DD */
    fechaIngreso: string;
    fechaRetiro?: string;
    fechaLiquidacionInicio: string;
    fechaLiquidacionFin: string;
    /** Días con años de 360 y meses de 30 (anexo §8.3.1). */
    tiempoLaborado: number;
  };
  /** Tabla 5.5.1: 1 semanal, 2 decenal, 3 catorcenal, 4 quincenal, 5 mensual. */
  periodoNomina: string;
  trabajador: TrabajadorNe;
  pago: { forma: string; metodo: string; banco?: string; tipoCuenta?: string; numeroCuenta?: string };
  /** Fechas de pago YYYY-MM-DD; al menos una. */
  fechasPagos: string[];
  devengados: DevengadosNe;
  deducciones: DeduccionesNe;
}

/** Empleador y numeración: lo que pone el emisor en cada documento. */
export interface EmisionNe {
  /** YYYY-MM-DD y HH:MM:SS-05:00 de generación. */
  fecha: string;
  hora: string;
  prefijo: string;
  consecutivo: number;
  empleador: {
    /** NIT sin dígito de verificación. */
    nit: string;
    dv: string;
    razonSocial: string;
    /** Departamento DANE de 2 dígitos y municipio DANE de 5. */
    departamento: string;
    municipio: string;
    direccion: string;
  };
}

/** El documento al que apunta una nota de ajuste (103). */
export interface PredecesorNe {
  numero: string;
  cune: string;
  /** YYYY-MM-DD */
  fecha: string;
}

/** NominaIndividual (TipoXML 102). */
export interface ModeloNominaIndividual {
  emision: EmisionNe;
  documento: DocumentoNe;
}

/** TipoNota del ajuste: Reemplazar = 1, Eliminar = 2. */
export const TipoNota = { Reemplazar: 1, Eliminar: 2 } as const;
export type TipoNota = (typeof TipoNota)[keyof typeof TipoNota];

/** NominaIndividualDeAjuste (TipoXML 103). Reemplazar lleva el documento completo corregido; Eliminar solo el predecesor. */
export type ModeloNominaAjuste =
  | { tipoNota: typeof TipoNota.Reemplazar; emision: EmisionNe; predecesor: PredecesorNe; documento: DocumentoNe }
  | { tipoNota: typeof TipoNota.Eliminar; emision: EmisionNe; predecesor: PredecesorNe };

/** Lo que no es del documento sino del entorno: ambiente y software de NÓMINA (no el de la factura). */
export interface ContextoNomina {
  /** 1 producción, 2 habilitación. */
  tipoAmbiente: '1' | '2';
  softwareId: string;
  softwarePin: string;
}

export interface TotalesNe {
  devengados: Centavos;
  deducciones: Centavos;
  comprobante: Centavos;
}

export interface ResultadoNomina {
  xml: string;
  /** Prefijo + consecutivo. */
  numero: string;
  cune: string;
  totales: TotalesNe;
}
