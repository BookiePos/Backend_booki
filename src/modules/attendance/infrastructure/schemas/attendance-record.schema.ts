import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AttendanceRecordDocument = HydratedDocument<AttendanceRecord>;

/**
 * Registro de asistencia de un empleado en una sede y día: hora de entrada y
 * de salida (HH:MM) y horas trabajadas. Base del módulo de nómina (control de
 * horas por punto de venta). Un registro por empleado+sede+día. El empleado
 * proviene del expediente de RRHH (colección `employees`).
 */
@Schema({ timestamps: true, collection: 'attendance_records' })
export class AttendanceRecord {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  /** Empleado (expediente RRHH) al que pertenece el registro. */
  @Prop({ required: true, index: true })
  employeeId!: string;

  /** Nombre del empleado (snapshot para el listado/nómina). */
  @Prop({ required: true, trim: true })
  employeeName!: string;

  /** Día del registro (YYYY-MM-DD, zona local de la sede). */
  @Prop({ required: true })
  workDate!: string;

  /** Hora de entrada (HH:MM). */
  @Prop({ trim: true })
  checkIn?: string;

  /** Hora de salida (HH:MM). */
  @Prop({ trim: true })
  checkOut?: string;

  /** Horas trabajadas calculadas a partir de entrada/salida. */
  @Prop({ default: 0, min: 0 })
  hours!: number;

  @Prop({ trim: true })
  note?: string;

  /** Quién registró/editó las horas. */
  @Prop({ trim: true })
  registeredByEmail?: string;
}

export const AttendanceRecordSchema =
  SchemaFactory.createForClass(AttendanceRecord);

// Un registro por empleado + sede + día.
AttendanceRecordSchema.index(
  { sedeId: 1, employeeId: 1, workDate: 1 },
  { unique: true },
);
