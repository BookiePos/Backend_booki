import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Saldo a favor de un cliente (PUC 2805, Fase 6C): lo que el negocio le debe
 * por una devolución, una rebaja o un descuento reconocido «a favor», y que
 * el cliente gasta al pagar otra venta con el medio `saldo_favor`.
 *
 * Dos colecciones a propósito:
 * - `saldo_favor_clientes`: una fila por cliente con el saldo vivo. Es la que
 *   se descuenta con un `findOneAndUpdate` condicionado a `saldo ≥ monto`: dos
 *   cobros a la vez nunca gastan el mismo peso.
 * - `saldo_favor_movimientos`: el auxiliar inmutable (abono, consumo, reverso)
 *   con la operación que lo originó. Su índice único por origen hace
 *   idempotente cada paso, y su suma por cliente se compara con el saldo en el
 *   reporte (`descuadre`).
 */
export type SaldoFavorClienteDocument = HydratedDocument<SaldoFavorCliente>;

@Schema({ timestamps: true, collection: 'saldo_favor_clientes' })
export class SaldoFavorCliente {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ required: true, default: 0, min: 0 })
  saldo!: number;

  @Prop({ trim: true })
  customerName?: string;
}

export const SaldoFavorClienteSchema = SchemaFactory.createForClass(SaldoFavorCliente);
SaldoFavorClienteSchema.index({ customerId: 1 }, { unique: true, name: 'saldo_favor_cliente' });

export type SaldoFavorMovimientoDocument = HydratedDocument<SaldoFavorMovimiento>;

export type TipoMovimientoSaldoFavor = 'abono' | 'consumo' | 'reverso';

@Schema({ timestamps: true, collection: 'saldo_favor_movimientos' })
export class SaldoFavorMovimiento {
  /** Sin cliente: el saldo quedó en la 2805 pero la venta no tenía tercero. */
  @Prop({ type: Types.ObjectId, ref: 'Customer', default: null })
  customerId?: Types.ObjectId | null;

  @Prop({ type: String, required: true, enum: ['abono', 'consumo', 'reverso'] })
  tipo!: TipoMovimientoSaldoFavor;

  /** Siempre positivo: el signo lo da `tipo` (abono y reverso suman, consumo resta). */
  @Prop({ required: true, min: 0 })
  amount!: number;

  /** `sale_return` (devolución o rebaja), `nota_sin_referencia` o `sale` (cobro). */
  @Prop({ required: true })
  sourceType!: string;

  @Prop({ required: true })
  sourceId!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ required: true })
  fecha!: string;

  @Prop({ trim: true })
  memo?: string;
}

export const SaldoFavorMovimientoSchema = SchemaFactory.createForClass(SaldoFavorMovimiento);
// Un movimiento por (origen, tipo): el reintento no abona ni consume dos veces.
SaldoFavorMovimientoSchema.index(
  { sourceType: 1, sourceId: 1, tipo: 1 },
  { unique: true, name: 'saldo_favor_movimiento_origen' },
);
SaldoFavorMovimientoSchema.index({ customerId: 1, createdAt: -1 });
