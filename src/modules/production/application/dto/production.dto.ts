import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  IVA_RATES,
  IVA_TYPES,
  IvaRate,
  IvaType,
} from '../../../catalog/domain/catalog.constants';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ─── Recetas (BOM) ───────────────────────────────────────────────────────────

export class BomLineDto {
  @IsMongoId()
  productId!: string;

  /**
   * Cantidades en decimal, no enteras: media libra de mantequilla es un insumo
   * perfectamente normal. El dinero sí va en entero (ver `extraCost`).
   */
  @IsNumber()
  @IsPositive()
  qty!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateBomDto {
  /** Ítem de inventario que produce la receta. */
  @IsMongoId()
  productId!: string;

  @IsString()
  name!: string;

  @IsNumber()
  @IsPositive()
  outputQty!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BomLineDto)
  lines!: BomLineDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  extraCost?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateBomDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  outputQty?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BomLineDto)
  lines?: BomLineDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  extraCost?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ─── Órdenes de producción ───────────────────────────────────────────────────

export class ProductionLineDto {
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

export class CreateProductionOrderDto {
  @IsMongoId()
  sedeId!: string;

  /** Terminado a fabricar. */
  @IsMongoId()
  productId!: string;

  @Matches(YMD, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  @IsNumber()
  @IsPositive()
  plannedQty!: number;

  /**
   * Insumos. Si se omite, se explota la receta del terminado a prorrata de
   * `plannedQty`. Enviarlos a mano permite fabricar sin receta registrada.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductionLineDto)
  lines?: ProductionLineDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  extraCost?: number;

  @IsOptional()
  @IsString()
  note?: string;

  /** Arranca la orden de una vez, sin pasar por borrador. */
  @IsOptional()
  @IsBoolean()
  start?: boolean;
}

export class UpdateProductionOrderDto {
  @IsOptional()
  @Matches(YMD, { message: 'date debe ser YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  plannedQty?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductionLineDto)
  lines?: ProductionLineDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  extraCost?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CompleteProductionOrderDto {
  /**
   * Salida real del lote. Si se omite se toma `plannedQty`; declararla es lo
   * que permite ver la merma del proceso contra lo planeado.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  producedQty?: number;

  /** Código del lote del terminado; si no llega, se genera (OP-...). */
  @IsOptional()
  @IsString()
  lotCode?: string;

  /** Vencimiento del terminado (obligatorio si el producto es perecedero). */
  @IsOptional()
  @Matches(YMD, { message: 'expiresAt debe ser YYYY-MM-DD' })
  expiresAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  extraCost?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

// ─── Puente hacia Productos (catálogo vendible) ──────────────────────────────

/**
 * Saca el terminado a la venta: crea su producto del catálogo del POS,
 * abastecido directamente del ítem de inventario que produce la receta.
 *
 * El SKU no se pide: en un vendible de fuente `inventory` lo manda el ítem
 * vinculado, que es la única forma de que caja e inventario hablen del mismo
 * código.
 */
export class PublishOutputDto {
  /** Precio al público (IVA incluido), en COP entero. */
  @IsInt()
  @Min(0)
  salePrice!: number;

  @IsOptional()
  @IsIn(IVA_RATES as readonly number[])
  ivaRate?: IvaRate;

  @IsOptional()
  @IsIn(IVA_TYPES as readonly string[])
  ivaType?: IvaType;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;
}
