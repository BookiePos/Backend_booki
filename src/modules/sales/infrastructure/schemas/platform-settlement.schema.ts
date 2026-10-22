import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PLATFORM_CODES, PlatformCode } from '../../domain/platform-orders';

export type PlatformSettlementDocument = HydratedDocument<PlatformSettlement>;

/**
 * Liquidación de una plataforma de domicilio (ítem 7.5): la plataforma consigna
 * lo de una tanda de pedidos, menos su comisión. Cancela la cuenta por cobrar de
 * esos pedidos y reconoce la comisión como gasto (ver `postPlatformSettlement`).
 *
 * Es el documento operativo; el hecho contable vive en el asiento
 * `platform_settlement` ligado por su id. Anular la liquidación reversa el
 * asiento y libera los pedidos.
 */
@Schema({ timestamps: true, collection: 'platform_settlements' })
export class PlatformSettlement {
  @Prop({ required: true, enum: PLATFORM_CODES })
  platform!: PlatformCode;

  @Prop({ type: Types.ObjectId, ref: 'Sede', required: true })
  sedeId!: Types.ObjectId;

  /** Pedidos (ventas) que esta liquidación cobró. */
  @Prop({ type: [Types.ObjectId], default: [] })
  saleIds!: Types.ObjectId[];

  /** Lo que la plataforma debía por esos pedidos (Σ total + domicilio). */
  @Prop({ required: true, min: 0 })
  gross!: number;

  /** Lo consignado al negocio (neto). */
  @Prop({ required: true, min: 0 })
  received!: number;

  /** Comisión y ajustes de la plataforma (gasto, sin IVA). */
  @Prop({ required: true, min: 0 })
  commission!: number;

  /** IVA de la comisión, si el negocio lo descuenta. */
  @Prop({ default: 0, min: 0 })
  commissionIva!: number;

  /** Fecha de la consignación (YYYY-MM-DD). */
  @Prop({ required: true })
  date!: string;

  @Prop({ trim: true, maxlength: 240 })
  note?: string;

  @Prop({ required: true, enum: ['active', 'void'], default: 'active' })
  status!: 'active' | 'void';

  @Prop()
  createdByEmail?: string;

  @Prop()
  voidedByEmail?: string;

  @Prop()
  voidedAt?: Date;
}

export const PlatformSettlementSchema = SchemaFactory.createForClass(PlatformSettlement);

PlatformSettlementSchema.index({ sedeId: 1, platform: 1, date: -1 });
