import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  DIAN_DOC_TYPE_CODES,
  REGIMENES,
  RESPONSABILIDADES_FISCALES,
  TIPOS_PERSONA,
} from '../../domain/datos-fiscales';

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

  // ── Datos fiscales del adquiriente DIAN (Anexo FEV 1.9). Todos opcionales:
  // los clientes anteriores no los tienen y no se adivinan. ────────────────────

  /** Código DIAN del tipo de documento (13 CC, 31 NIT, 22 CE, 41 pasaporte…). */
  @Prop({ enum: DIAN_DOC_TYPE_CODES })
  dianDocType?: string;

  /** Dígito de verificación; solo para NIT (tipo 31). */
  @Prop({ trim: true })
  nitDv?: string;

  /** 1 = jurídica, 2 = natural. */
  @Prop({ enum: TIPOS_PERSONA })
  tipoPersona?: string;

  /** Responsabilidades fiscales del RUT: O-13, O-15, O-23, O-47, R-99-PN. */
  @Prop({ type: [String], enum: RESPONSABILIDADES_FISCALES })
  responsabilidadesFiscales?: string[];

  @Prop({ enum: REGIMENES })
  regimen?: string;

  /** Código DANE del municipio (5 dígitos). */
  @Prop({ trim: true })
  municipioDane?: string;

  @Prop({ trim: true })
  emailFacturacion?: string;

  /** Cupo de crédito para fiado (0 = sin control de cupo). */
  @Prop({ default: 0, min: 0 })
  creditLimit!: number;

  /**
   * Lista de precios con la que se le cobra: mayorista, distribuidor…
   *
   * Sin ella se cobra el precio de mostrador, que es la venta normal. Existe
   * para que el descuento del mayorista no dependa de que el cajero se acuerde
   * de aplicarlo a mano en cada venta.
   */
  @Prop({ type: Types.ObjectId, ref: 'PriceList' })
  priceListId?: Types.ObjectId;

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
