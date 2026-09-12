import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  DISCOUNT_TYPES,
  DiscountType,
  PAYMENT_METHODS,
  PaymentMethod,
} from '../../domain/sales.constants';
import {
  ORDER_TYPES,
  OrderType,
} from '../../../delivery/domain/delivery.constants';

export class SaleDiscountDto {
  @IsIn(DISCOUNT_TYPES as readonly string[])
  type!: DiscountType;

  /** Monto en pesos (amount) o porcentaje 0–100 (percent). */
  @IsNumber()
  @Min(0)
  value!: number;
}

export class SaleLineDto {
  @IsMongoId()
  productId!: string;

  // El POS vende por unidad (la línea persiste unit:'und'); no hay venta por
  // peso/granel en ningún flujo. Las fracciones de receta (p. ej. 0.15 kg) viven
  // en la definición del producto de catálogo, no en la cantidad vendida.
  @IsInt()
  @IsPositive()
  qty!: number;

  /** Descuento predefinido (de la sede) aplicado a esta línea. Opcional. */
  @IsOptional()
  @IsMongoId()
  discountId?: string;
}

export class SalePaymentDto {
  @IsIn(PAYMENT_METHODS as readonly string[])
  method!: PaymentMethod;

  /** Monto recibido en efectivo (para calcular el cambio). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  received?: number;

  /** Vencimiento de la cuenta por cobrar en ventas a crédito (fiado). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate debe ser YYYY-MM-DD' })
  dueDate?: string;

  /**
   * Deudor de una venta a crédito (fiado): un cliente REGISTRADO (→ CxC) o un
   * empleado (→ deducción de nómina, pendiente de aprobación). Obligatorio
   * cuando method='credit'.
   */
  @IsOptional()
  @IsIn(['customer', 'employee'])
  debtorType?: 'customer' | 'employee';

  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsOptional()
  @IsMongoId()
  employeeId?: string;
}

/** Datos del cliente para la factura (todos opcionales). */
export class SaleCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  idNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;
}

/** A dónde se lleva el pedido. */
export class SaleDeliveryDto {
  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;

  /** Quién lo lleva. Texto libre: casi siempre es un nombre de pila. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courier?: string;

  /** Zona con tarifa fija. El servidor pone el precio, no el navegador. */
  @IsOptional()
  @IsMongoId()
  zoneId?: string;

  /**
   * Tarifa escrita a mano, para el pedido que no cae en ninguna zona.
   * Si además se manda `zoneId`, manda la zona: las zonas existen para que el
   * precio no dependa de quién tome el pedido.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee?: number;
}

/** El precio NUNCA viene del cliente: se toma el salePrice del servidor. */
export class CreateSaleDto {
  @IsMongoId()
  sedeId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SaleLineDto)
  lines!: SaleLineDto[];

  @ValidateNested()
  @Type(() => SalePaymentDto)
  payment!: SalePaymentDto;

  /** Descuento opcional sobre el total (requiere pos.discount.authorize). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;

  /**
   * Lista de precios elegida A MANO en el terminal, para el cliente de paso
   * que se lleva una caja entera y no está registrado.
   *
   * Requiere `pos.discount.authorize`: elegirla es decidir cobrar menos, igual
   * que aplicar un descuento. La lista que el cliente REGISTRADO ya tiene
   * asignada no pide permiso — no la está decidiendo el cajero.
   */
  @IsOptional()
  @IsMongoId()
  priceListId?: string;

  /** Propina voluntaria (restaurante): se cobra encima del total. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  tip?: number;

  /** Cómo sale el pedido. Por omisión, mostrador. */
  @IsOptional()
  @IsIn(ORDER_TYPES as readonly string[])
  orderType?: OrderType;

  /**
   * A dónde se lleva. Solo se tiene en cuenta con `orderType: 'domicilio'`.
   *
   * La TARIFA no viaja desde el navegador cuando hay zona: se manda el id de la
   * zona y el servidor pone el precio. `fee` solo se usa para el pedido raro
   * que no cae en ninguna zona, y es la casilla a mano que se acordó.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDeliveryDto)
  delivery?: SaleDeliveryDto;

  /** Datos del cliente para la factura (opcional). */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleCustomerDto)
  customer?: SaleCustomerDto;

  /**
   * Cliente REGISTRADO al que se le está vendiendo, sin importar cómo paga.
   *
   * `payment.customerId` solo existe para el fiado, donde identifica al deudor
   * de la cuenta por cobrar. Pero la tienda que compra por cajas casi siempre
   * paga de contado o por transferencia, y su lista de precios tiene que
   * aplicarse igual: para eso está este campo.
   */
  @IsOptional()
  @IsMongoId()
  customerId?: string;
}
