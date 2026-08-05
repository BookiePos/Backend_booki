import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AttendanceEditRequestDocument =
  HydratedDocument<AttendanceEditRequest>;

export const EDIT_REQUEST_STATUSES = [
  'pending', // solicitada por el trabajador, a la espera de revisión
  'approved', // aprobada; sus horas ya se aplicaron al registro
  'rejected', // rechazada; el registro no cambia
] as const;
export type EditRequestStatus = (typeof EDIT_REQUEST_STATUSES)[number];

/**
 * Solicitud de un trabajador para corregir sus horas ya registradas (que son
 * inmutables desde el POS). Queda pendiente hasta que en Operación la aprueban
 * (aplica las horas propuestas al registro) o la rechazan.
 */
@Schema({ timestamps: true, collection: 'attendance_edit_requests' })
export class AttendanceEditRequest {
  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true, index: true })
  sedeId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  employeeId!: string;

  @Prop({ required: true, trim: true })
  employeeName!: string;

  /** Día que se quiere corregir (YYYY-MM-DD). */
  @Prop({ required: true })
  workDate!: string;

  /** Horas actuales (snapshot al momento de solicitar), para comparar. */
  @Prop({ trim: true })
  currentCheckIn?: string;

  @Prop({ trim: true })
  currentCheckOut?: string;

  /** Horas propuestas por el trabajador. */
  @Prop({ trim: true })
  proposedCheckIn?: string;

  @Prop({ trim: true })
  proposedCheckOut?: string;

  /** Motivo del cambio (obligatorio: contexto para quien aprueba). */
  @Prop({ required: true, trim: true })
  reason!: string;

  @Prop({
    required: true,
    enum: EDIT_REQUEST_STATUSES,
    default: 'pending',
    index: true,
  })
  status!: EditRequestStatus;

  @Prop({ trim: true })
  requestedByEmail?: string;

  @Prop({ trim: true })
  resolvedByEmail?: string;

  /** Nota de quien aprueba/rechaza (opcional). */
  @Prop({ trim: true })
  resolutionNote?: string;
}

export const AttendanceEditRequestSchema = SchemaFactory.createForClass(
  AttendanceEditRequest,
);

AttendanceEditRequestSchema.index({ status: 1, createdAt: -1 });
