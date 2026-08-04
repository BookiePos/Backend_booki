import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Un eje de variación, p. ej. { name: 'Talla', values: ['S','M','L'] }. */
export class VariantAxisDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  values!: string[];
}

/**
 * Alta de un producto retail con variantes. Genera un producto "padre"
 * (plantilla, no vendible) y una fila hija por cada combinación de los ejes
 * (producto cartesiano). Cada hija hereda estos datos base y lleva su propio
 * SKU derivado, stock y precio.
 */
export class CreateProductVariantsDto {
  /** Prefijo para derivar el SKU de cada hija (p. ej. CAMISA → CAMISA-M-ROJO). */
  @IsString()
  @MinLength(1)
  skuPrefix!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  supplier?: string;

  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VariantAxisDto)
  axes!: VariantAxisDto[];
}
