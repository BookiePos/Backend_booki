import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

/**
 * Registro de auditoría inmutable (append-only): quién, qué, cuándo, desde
 * dónde. No se edita ni se borra nunca. Se alimenta desde un interceptor global
 * que captura toda operación de escritura (POST/PATCH/PUT/DELETE).
 */
@Schema({ timestamps: { createdAt: 'at', updatedAt: false }, collection: 'core_audit_logs' })
export class AuditLog {
  @Prop({ index: true })
  userId?: string;

  @Prop({ trim: true, index: true })
  userEmail?: string;

  @Prop({ trim: true })
  userName?: string;

  @Prop({ trim: true })
  role?: string;

  /** Verbo HTTP: POST/PATCH/PUT/DELETE. */
  @Prop({ required: true })
  method!: string;

  /** Ruta afectada (recurso). */
  @Prop({ required: true, index: true })
  path!: string;

  /** Primer segmento de la ruta = módulo (para filtrar/agrupar). */
  @Prop({ index: true })
  module?: string;

  @Prop()
  statusCode?: number;

  @Prop({ default: true })
  success!: boolean;

  @Prop()
  ip?: string;

  @Prop()
  durationMs?: number;

  /** Mensaje de error si la operación falló. */
  @Prop({ trim: true })
  error?: string;

  /** `at` lo añade timestamps (createdAt renombrado). */
  at?: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

AuditLogSchema.index({ at: -1 });
AuditLogSchema.index({ module: 1, at: -1 });
