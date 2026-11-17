import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DESTINOS_CESANTIAS,
  ESTADOS_PAGO_PRESTACION,
  TIPOS_PRESTACION,
  type DestinoCesantias,
  type EstadoPagoPrestacion,
  type TipoPrestacion,
} from '../../domain/pago-prestacion';

export type PayrollPagoPrestacionDocument = HydratedDocument<PayrollPagoPrestacion>;

/** Índice que impide registrar dos veces el mismo pago (mismo trabajador, prestación y tramo). */
export const INDICE_PAGO_PRESTACION_VIVO = 'pago_prestacion_vivo_unico';

/**
 * Pago de prima, cesantías o intereses sobre cesantías fuera del retiro
 * (decisión 2 del dueño, Fase 8). Es el evento que consume la provisión (2610)
 * y que la nómina electrónica reporta en el mes de `pago.fecha`.
 *
 * Inmutable: no se edita. Se corrige anulándolo (contra-asiento) y registrando otro.
 */
@Schema({ timestamps: true, collection: 'payroll_pagos_prestaciones' })
export class PayrollPagoPrestacion {
  @Prop({ required: true, index: true })
  employeeId!: string;

  @Prop({ trim: true })
  employeeName?: string;

  /** Sede del empleado al registrar el pago: la del asiento. */
  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ required: true, enum: TIPOS_PRESTACION as unknown as string[] })
  tipo!: TipoPrestacion;

  /** Lo pagado en pesos enteros, antes de la retención. */
  @Prop({ required: true })
  monto!: number;

  /** Retención en la fuente practicada (solo prima), en pesos enteros. */
  @Prop({ required: true, default: 0 })
  retencionFuente!: number;

  /** Tramo que cubre el pago (YYYY-MM-DD, ambos incluidos). */
  @Prop({ required: true })
  periodoDesde!: string;

  @Prop({ required: true })
  periodoHasta!: string;

  /** Días del tramo por el método 360 (`Primas@Cantidad`). */
  @Prop({ required: true })
  dias!: number;

  /** Medio (10/20/42/47) y fecha real del egreso. */
  @Prop({ type: { medio: String, fecha: String }, _id: false, required: true })
  pago!: { medio: string; fecha: string };

  /** Solo cesantías: al fondo (lo normal) o al trabajador. */
  @Prop({ enum: DESTINOS_CESANTIAS as unknown as string[] })
  destino?: DestinoCesantias;

  /** Fondo de cesantías o referencia de la consignación. */
  @Prop({ trim: true })
  fondo?: string;

  @Prop({ trim: true })
  observacion?: string;

  @Prop({ required: true, default: 'registrado', enum: ESTADOS_PAGO_PRESTACION as unknown as string[] })
  estado!: EstadoPagoPrestacion;

  @Prop({ trim: true })
  registradoPor?: string;

  @Prop({ trim: true })
  anuladoPor?: string;

  @Prop()
  anuladoEn?: Date;

  @Prop({ trim: true })
  motivoAnulacion?: string;
}

export const PayrollPagoPrestacionSchema = SchemaFactory.createForClass(PayrollPagoPrestacion);
// Un solo pago vivo por trabajador, prestación y tramo: el reintento no paga dos veces.
PayrollPagoPrestacionSchema.index(
  { employeeId: 1, tipo: 1, periodoDesde: 1, periodoHasta: 1 },
  { unique: true, partialFilterExpression: { estado: 'registrado' }, name: INDICE_PAGO_PRESTACION_VIVO },
);
// La nómina electrónica los busca por el mes del pago.
PayrollPagoPrestacionSchema.index({ estado: 1, 'pago.fecha': 1 });
