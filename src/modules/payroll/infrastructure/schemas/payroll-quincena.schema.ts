import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { INDICE_QUINCENA_VIVA } from '../../domain/payroll-quincena.indices';

export type PayrollQuincenaDocument = HydratedDocument<PayrollQuincena>;

/** Lo que se le pagó a un trabajador en la primera quincena. */
@Schema({ _id: false })
export class LineaQuincena {
  @Prop({ required: true })
  employeeId!: string;

  @Prop({ trim: true })
  employeeName?: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  /** Días de la quincena que se le pagan (15 menos ingreso tardío y ausencias). */
  @Prop({ required: true })
  dias!: number;

  @Prop({ required: true })
  sueldo!: number;

  @Prop({ required: true, default: 0 })
  auxilioTransporte!: number;

  /** Recargos nocturnos y dominicales del 1 al 15. */
  @Prop({ required: true, default: 0 })
  recargos!: number;

  /** Horas extra del 1 al 15. */
  @Prop({ required: true, default: 0 })
  horasExtra!: number;

  @Prop({ required: true, default: 0 })
  salud!: number;

  @Prop({ required: true, default: 0 })
  pension!: number;

  @Prop({ required: true, default: 0 })
  fsp!: number;

  /** Lo que se le entregó, en pesos enteros. */
  @Prop({ required: true })
  neto!: number;
}
const LineaQuincenaSchema = SchemaFactory.createForClass(LineaQuincena);

/**
 * Pago de la primera quincena de un mes (días 1 a 15).
 *
 * No es una nómina aparte ni un anticipo: es parte del pago del salario del mes
 * ya trabajado. El mes se sigue liquidando completo al cierre (PILA, retención
 * y nómina electrónica son mensuales) y la colilla descuenta lo que aquí se
 * pagó (`pagadoQuincena`). Contablemente es D 2505 / C caja o bancos el día del
 * pago, y el cierre del mes vuelve a acreditar la 2505 por esa misma cifra.
 *
 * Inmutable: no se edita. Se corrige anulándola (contra-asiento) y registrando otra.
 */
@Schema({ timestamps: true, collection: 'payroll_quincenas' })
export class PayrollQuincena {
  /** Mes YYYY-MM. */
  @Prop({ required: true, index: true })
  period!: string;

  /** 'all' | 'sede' */
  @Prop({ required: true, default: 'all' })
  coverage!: string;

  @Prop({ type: Types.ObjectId, ref: 'Sede', default: null })
  sedeId?: Types.ObjectId | null;

  @Prop({ required: true, default: 'pagada', enum: ['pagada', 'anulada'] })
  estado!: 'pagada' | 'anulada';

  /** Medio (10/20/42/47) y fecha real del pago. */
  @Prop({ type: { medio: String, fecha: String }, _id: false, required: true })
  pago!: { medio: string; fecha: string };

  @Prop({ type: [LineaQuincenaSchema], default: [] })
  lineas!: LineaQuincena[];

  @Prop({ required: true })
  total!: number;

  @Prop({ trim: true })
  registradaPor?: string;

  @Prop({ trim: true })
  anuladaPor?: string;

  @Prop()
  anuladaEn?: Date;

  @Prop({ trim: true })
  motivoAnulacion?: string;
}

export const PayrollQuincenaSchema = SchemaFactory.createForClass(PayrollQuincena);
PayrollQuincenaSchema.index({ period: 1, estado: 1 });
PayrollQuincenaSchema.index({ 'lineas.employeeId': 1, period: 1, estado: 1 });
PayrollQuincenaSchema.index(INDICE_QUINCENA_VIVA.keys, INDICE_QUINCENA_VIVA.options);
