import { Type } from 'class-transformer';
import {
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Ítem que se agrega a la cuenta (el precio lo pone el servidor). */
export class OrderLineInputDto {
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

export class CreateOrderDto {
  @IsMongoId()
  sedeId!: string;

  /** Etiqueta libre (mesa / cliente). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** Ítems iniciales (opcional: se puede abrir vacía). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines?: OrderLineInputDto[];
}
