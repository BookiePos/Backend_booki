import { Type } from 'class-transformer';
import { PLATFORM_CODES, PlatformCode } from '../../domain/platform-orders';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDefined,
  IsBoolean,
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  CARD_FRANCHISES,
  CARD_TYPES,
  CardFranchise,
  CardType,
  DISCOUNT_TYPES,
  DiscountType,
  PAYMENT_CHANNELS,
  PAYMENT_METHODS,
  PaymentChannel,
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

  /** Canal digital (ítem 6.4): datáfono, Nequi, Daviplata o QR/Bre-B. */
  @IsOptional()
  @IsIn(PAYMENT_CHANNELS as readonly string[])
  channel?: PaymentChannel;

  /** Solo datáfono: débito o crédito. */
  @IsOptional()
  @IsIn(CARD_TYPES as readonly string[])
  cardType?: CardType;

  /** Solo datáfono: franquicia. */
  @IsOptional()
  @IsIn(CARD_FRANCHISES as readonly string[])
  franchise?: CardFranchise;

  /** Aprobación del datáfono, últimos 4 o número de la billetera. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  reference?: string;

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

/**
 * Una parte de un cobro mixto (ítem 6.9). En efectivo, `amount` es lo que el
 * cliente entregó: si sobra, el vuelto sale de ahí. En los demás medios es lo
 * que se cobró por ese medio, y no puede pasarse del total.
 *
 * La parte fiada lleva su deudor como el `payment` de siempre (`debtorType`,
 * `customerId` o `employeeId`, `dueDate`).
 */
export class SalePaymentPartDto {
  @IsIn(PAYMENT_METHODS as readonly string[])
  method!: PaymentMethod;

  /** Canal digital (ítem 6.4): datáfono, Nequi, Daviplata o QR/Bre-B. */
  @IsOptional()
  @IsIn(PAYMENT_CHANNELS as readonly string[])
  channel?: PaymentChannel;

  /** Solo datáfono: débito o crédito. */
  @IsOptional()
  @IsIn(CARD_TYPES as readonly string[])
  cardType?: CardType;

  /** Solo datáfono: franquicia. */
  @IsOptional()
  @IsIn(CARD_FRANCHISES as readonly string[])
  franchise?: CardFranchise;

  /** Aprobación del datáfono, últimos 4 o número de la billetera. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  reference?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate debe ser YYYY-MM-DD' })
  dueDate?: string;

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

/**
 * Quién vendió. No siempre es quien cobra: en el mostrador uno atiende y otro
 * pasa la venta por la caja, y lo que se quiere saber es cuánto vendió cada uno.
 */
export class SaleSellerDto {
  /** Empleado de nómina, si lo es. Sin él, el vendedor es solo un nombre. */
  @IsOptional()
  @IsMongoId()
  employeeId?: string;

  @IsString()
  @MaxLength(120)
  name!: string;
}

/** Empaque gastado en un cobro, anotado a mano por quien cobra. */
export class SalePackagingDto {
  /** Ítem de INVENTARIO (la bolsa), no un producto vendible. */
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
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

/**
 * Pedido de una plataforma de domicilio (ítem 7.5). Con él, el único medio de
 * pago admitido es `platform` y no hay propina (va por la app de la plataforma).
 */
export class SalePlatformDto {
  @IsIn(PLATFORM_CODES as readonly string[])
  code!: PlatformCode;

  /** Código del pedido en la plataforma; junto con `code` no se puede repetir. */
  @IsString()
  @MaxLength(80)
  externalId!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'orderedAt debe ser YYYY-MM-DD' })
  orderedAt?: string;

  /** Comisión estimada del portal, en pesos. La real se anota al liquidar. */
  @IsOptional()
  @IsInt()
  @Min(0)
  commissionEstimate?: number;
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

  /**
   * Pago con un solo medio: la API de siempre, que sigue funcionando igual.
   * Obligatorio si no viene `payments`.
   */
  @ValidateIf((o: CreateSaleDto) => o.payments == null)
  @IsDefined({ message: 'Falta el medio de pago: manda payment o payments' })
  @ValidateNested()
  @Type(() => SalePaymentDto)
  payment?: SalePaymentDto;

  /**
   * Cobro mixto en un tiquete (ítem 6.9): efectivo + tarjeta, etc. Si viene,
   * reemplaza a `payment` (mandar los dos es un error). Ver
   * `domain/sale-payments.ts` para las reglas del reparto.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentPartDto)
  payments?: SalePaymentPartDto[];

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
   * Empaque gastado en ESTE cobro.
   *
   * No se le cobra al cliente —no suma al total— pero sí sale del inventario y
   * entra al costo de la venta.
   *
   * Qué significa exactamente depende de `packagingExplicit`; ver ahí.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePackagingDto)
  packaging?: SalePackagingDto[];

  /**
   * `packaging` es TODO el empaque de la venta, no un añadido.
   *
   * Con esta bandera, lo que cada producto declara en su ficha deja de
   * descontarse solo y manda exclusivamente la lista de arriba —vacía
   * incluida, que es lo que significa "sin empaques"—. Es la decisión de
   * producto: el empaque que baja del inventario es el que se confirma al
   * cobrar, y la ficha pasa a ser solo la semilla de la sugerencia.
   *
   * Existe como bandera y no como "si viene `packaging`, manda" porque hay que
   * distinguir tres cosas que si no se confunden: el POS nuevo diciendo "sin
   * empaques" (bandera con lista vacía), el POS nuevo diciendo "estos"
   * (bandera con lista), y un cliente viejo que no opina (sin bandera), donde
   * hay que seguir descontando la ficha y sumando el extra como siempre. El
   * backend se despliega antes que el frontend: mientras tanto el POS viejo
   * sigue cobrando igual.
   */
  @IsOptional()
  @IsBoolean()
  packagingExplicit?: boolean;

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

  /** Quién vendió. Sin este campo, el vendedor es quien cobra. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleSellerDto)
  seller?: SaleSellerDto;

  /**
   * Pedido de una plataforma de domicilio (ítem 7.5). Exige
   * `payment: { method: 'platform' }` y, al revés, ese medio exige este dato.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => SalePlatformDto)
  platform?: SalePlatformDto;
}
