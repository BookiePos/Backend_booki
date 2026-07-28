import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// ── Mesas ──────────────────────────────────────────────────────────────────
export class CreateTableDto {
  @IsMongoId()
  sedeId!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  zone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number;
}

export class UpdateTableDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  zone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ── Comandas ───────────────────────────────────────────────────────────────
export class OpenOrderDto {
  @IsMongoId()
  tableId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  guests?: number;
}

export class OrderItemDto {
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  qty!: number;

  @IsInt()
  @Min(0)
  unitPrice!: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  station?: string;
}

export class AddItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}

export class SetTipDto {
  @IsOptional()
  @IsBoolean()
  accepted?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  rate?: number;
}

export class CancelOrderDto {
  @IsString()
  reason!: string;
}
