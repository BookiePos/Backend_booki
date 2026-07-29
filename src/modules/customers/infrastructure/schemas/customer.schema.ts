import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CustomerDocument = HydratedDocument<Customer>;

export const CUSTOMER_DOC_TYPES = ['CC', 'NIT', 'CE', 'PAS'] as const;
export type CustomerDocType = (typeof CUSTOMER_DOC_TYPES)[number];

/**
 * Cliente registrado (directorio para facturación y cuentas por cobrar). Una
 * CxC/fiado SIEMPRE apunta a un cliente de aquí (o a un empleado, que va por
 * nómina). El nombre suelto de una factura de contado no requiere registro.
 */
@Schema({ timestamps: true, collection: 'customers' })
export class Customer {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, enum: CUSTOMER_DOC_TYPES, default: 'CC' })
  docType!: CustomerDocType;

  @Prop({ required: true, trim: true })
  docNumber!: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true })
  email?: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  city?: string;

  /** Cupo de crédito para fiado (0 = sin control de cupo). */
  @Prop({ default: 0, min: 0 })
  creditLimit!: number;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ default: true })
  active!: boolean;

  @Prop({ trim: true })
  createdByEmail?: string;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);

CustomerSchema.index({ docType: 1, docNumber: 1 }, { unique: true });
CustomerSchema.index({ name: 'text' });
