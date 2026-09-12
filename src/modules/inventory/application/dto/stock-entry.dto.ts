import {
  IsBoolean,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

/** Entrada de mercancía (recepción de compra o carga inicial). */
export class StockEntryDto {
  @IsMongoId()
  productId!: string;

  @IsMongoId()
  sedeId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;

  @IsOptional()
  @IsNumber()
  unitCost?: number;

  /**
   * `qty` y `unitCost` vienen en PRESENTACIONES de compra —3 bultos a $95.000
   * el bulto— y no en unidades de consumo. El backend los convierte con el
   * factor del producto, que es donde vive esa cuenta.
   */
  @IsOptional()
  @IsBoolean()
  inPurchaseUnits?: boolean;

  /** Código de lote; si el producto controla lotes y no llega, se genera. */
  @IsOptional()
  @IsString()
  lotCode?: string;

  /** Proveedor del que ingresa el lote (texto legible). */
  @IsOptional()
  @IsString()
  supplier?: string;

  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  /** Fecha de vencimiento (obligatoria si el producto es perecedero). */
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
