import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DIAN_STATUS, DianStatus } from '../../domain/einvoicing.constants';

/** Empleador (el emisor del documento) congelado al emitir. */
@Schema({ _id: false })
export class PayrollEmisor {
  @Prop() name?: string;
  @Prop() nit?: string;
  /** NIT base sin DV y solo dígitos (ver `normalizarNit`): llave de los índices únicos. */
  @Prop() nitNorm?: string;
  @Prop() nitDv?: string;
}
const PayrollEmisorSchema = SchemaFactory.createForClass(PayrollEmisor);

/** Trabajador del documento. Solo identificación: el detalle vive en el XML. */
@Schema({ _id: false })
export class PayrollEmpleado {
  @Prop({ type: Types.ObjectId, ref: 'Employee' }) employeeId?: Types.ObjectId;
  @Prop() docType?: string;
  /** Solo dígitos: llave del índice del 102 vigente. */
  @Prop() docNumber?: string;
  @Prop() name?: string;
}
const PayrollEmpleadoSchema = SchemaFactory.createForClass(PayrollEmpleado);

/** Documento al que apunta un ajuste (103). */
@Schema({ _id: false })
export class PayrollPredecesor {
  @Prop({ type: Types.ObjectId, ref: 'PayrollEDocument' }) documentId?: Types.ObjectId;
  @Prop() numero?: string;
  @Prop() cune?: string;
  @Prop() fecha?: string;
}
const PayrollPredecesorSchema = SchemaFactory.createForClass(PayrollPredecesor);

/** Totales del documento, en centavos (los mismos que alimentan el CUNE). */
@Schema({ _id: false })
export class PayrollTotales {
  @Prop({ min: 0 }) devengadosCentavos?: number;
  @Prop({ min: 0 }) deduccionesCentavos?: number;
  @Prop({ min: 0 }) comprobanteCentavos?: number;
}
const PayrollTotalesSchema = SchemaFactory.createForClass(PayrollTotales);

export type PayrollEDocumentDocument = HydratedDocument<PayrollEDocument>;

/**
 * Documento soporte de pago de nómina electrónica (NominaIndividual 102 /
 * NominaIndividualDeAjuste 103) de UN trabajador en UN mes. Numeración propia
 * (prefijo + consecutivo de nómina, contador `nomina:<NIT>:<prefijo>`): no
 * comparte contador con la factura. El XML firmado vive en el bucket privado
 * (`xmlPath`), como el de la factura. `dianStatus` usa la misma máquina de
 * estados (`sent` = en vuelo).
 */
@Schema({ timestamps: true, collection: 'payroll_e_documents' })
export class PayrollEDocument {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ type: PayrollEmisorSchema, required: true })
  emisor!: PayrollEmisor;

  @Prop({ type: PayrollEmpleadoSchema, required: true })
  empleado!: PayrollEmpleado;

  /** YYYY-MM del mes liquidado. */
  @Prop({ required: true })
  periodo!: string;

  /** 102 = NominaIndividual, 103 = NominaIndividualDeAjuste. */
  @Prop({ required: true, enum: ['102', '103'] })
  tipoXml!: '102' | '103';

  /** TipoNota del ajuste: 1 Reemplazar, 2 Eliminar. Solo en el 103. */
  @Prop({ enum: [1, 2] })
  tipoNota?: 1 | 2;

  @Prop({ required: true, trim: true, uppercase: true })
  prefix!: string;

  @Prop({ required: true, min: 1 })
  number!: number;

  /** Prefijo + consecutivo (NumeroSecuenciaXML/@Numero). */
  @Prop({ required: true })
  fullNumber!: string;

  @Prop({ required: true })
  issueDate!: string;

  @Prop({ required: true })
  issueTime!: string;

  /** '1' producción, '2' habilitación: el ambiente con el que se calculó el CUNE. */
  @Prop({ required: true, enum: ['1', '2'] })
  tipoAmbiente!: '1' | '2';

  @Prop({ required: true })
  cune!: string;

  @Prop({ type: PayrollTotalesSchema })
  totales?: PayrollTotales;

  @Prop({ type: PayrollPredecesorSchema })
  predecesor?: PayrollPredecesor;

  /**
   * El 102 (o 103) que cuenta hoy para el mes. Un ajuste aceptado deja de
   * serlo en su predecesor; así el mes se puede volver a emitir tras un Eliminar.
   */
  @Prop({ default: true })
  vigente!: boolean;

  /**
   * Raíz de la cadena de ajustes (el 102 original). Solo en los 103; la raíz
   * es el propio 102. Un Eliminar aceptado cierra TODA la cadena.
   */
  @Prop({ type: Types.ObjectId, ref: 'PayrollEDocument', index: true })
  raizId?: Types.ObjectId;

  /** Un Reemplazar aceptado pasó la vigencia al 103: este documento ya no se puede ajustar. */
  @Prop()
  superado?: boolean;

  /**
   * Un 103 aceptado cuyo cierre del predecesor/cadena no se pudo guardar. El
   * siguiente `consultar`/`transmitir`/`emitir` lo repara de forma idempotente.
   */
  @Prop()
  pendienteCierrePredecesor?: boolean;

  @Prop({ required: true, enum: DIAN_STATUS, default: 'draft' })
  dianStatus!: DianStatus;

  /** Ruta privada del XML firmado. */
  @Prop() xmlPath?: string;

  @Prop() trackId?: string;
  @Prop() zipKey?: string;

  /** Última respuesta de la DIAN o del adaptador. Nunca guarda secretos. */
  @Prop({ type: Object })
  respuestaDian?: Record<string, unknown>;

  @Prop() rechazoMotivo?: string;

  @Prop({ default: 0, min: 0 })
  intentos?: number;

  @Prop() enviadoAt?: Date;

  @Prop({ type: String })
  bloqueoTransmision?: string;

  @Prop({ type: Date })
  bloqueoHasta?: Date;

  /** Por qué el último intento no salió a la red (gate, credenciales de nómina). */
  @Prop({ type: Object })
  ultimoIntentoSinRed?: Record<string, unknown>;

  @Prop({ required: true })
  createdByEmail!: string;
}

export const PayrollEDocumentSchema = SchemaFactory.createForClass(PayrollEDocument);

/** Un solo documento por (empleador, prefijo, número): nunca se renumera ni se repite. */
export const INDICE_NOMINA_CONSECUTIVO = {
  keys: { 'emisor.nitNorm': 1, prefix: 1, number: 1 },
  options: {
    name: 'nomina_consecutivo_unico',
    unique: true,
    partialFilterExpression: { 'emisor.nitNorm': { $type: 'string' } },
  },
} as const;

/** Un 102 vigente por (empleador, mes, trabajador). */
export const INDICE_NOMINA_102_VIGENTE = {
  keys: { 'emisor.nitNorm': 1, periodo: 1, 'empleado.docNumber': 1 },
  options: {
    name: 'nomina_102_vigente_unico',
    unique: true,
    partialFilterExpression: { tipoXml: '102', vigente: true },
  },
} as const;

/**
 * Un 103 vigente por (predecesor, tipo de nota): reintentar el mismo ajuste no
 * crea otro, y un rechazo se corrige con el MISMO tipo; cambiar de idea
 * (Reemplazar ↔ Eliminar) es un documento nuevo, no una mutación del anterior.
 */
export const INDICE_NOMINA_103_POR_PREDECESOR = {
  keys: { 'emisor.nitNorm': 1, 'predecesor.cune': 1, tipoNota: 1 },
  options: {
    name: 'nomina_103_por_predecesor_unico',
    unique: true,
    partialFilterExpression: { tipoXml: '103', vigente: true },
  },
} as const;

for (const i of [INDICE_NOMINA_CONSECUTIVO, INDICE_NOMINA_102_VIGENTE, INDICE_NOMINA_103_POR_PREDECESOR]) {
  PayrollEDocumentSchema.index({ ...i.keys }, { ...i.options, partialFilterExpression: { ...i.options.partialFilterExpression } });
}
PayrollEDocumentSchema.index({ sedeId: 1, periodo: 1 });
