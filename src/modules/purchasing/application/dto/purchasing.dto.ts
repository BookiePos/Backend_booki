import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export class PurchaseLineDto {
  @IsOptional()
  @IsMongoId()
  productId?: string;

  @IsString()
  description!: string;

  @IsInt()
  @Min(1)
  qty!: number;

  @IsInt()
  @Min(0)
  unitCost!: number;

  @IsOptional()
  @IsString()
  taxCode?: string;
}

export class CreatePurchaseOrderDto {
  @IsMongoId()
  sedeId!: string;

  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsString()
  supplierName!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'issueDate debe ser YYYY-MM-DD' })
  issueDate!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expectedDate debe ser YYYY-MM-DD' })
  expectedDate?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines!: PurchaseLineDto[];

  @IsOptional()
  @IsString()
  note?: string;

  /** Si es true, la orden se crea directamente como 'sent'. */
  @IsOptional()
  @IsBoolean()
  send?: boolean;
}

export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsMongoId()
  supplierId?: string;

  @IsOptional()
  @IsString()
  supplierName?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expectedDate debe ser YYYY-MM-DD' })
  expectedDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines?: PurchaseLineDto[];

  @IsOptional()
  @IsString()
  note?: string;
}

export class ReceiveLineDto {
  @IsInt()
  @Min(0)
  lineIndex!: number;

  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @IsString()
  lotCode?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'expiresAt debe ser YYYY-MM-DD' })
  expiresAt?: string;
}

export class ReceivePurchaseOrderDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];

  @IsOptional()
  @IsString()
  note?: string;

  /** Genera una CxP por el valor recibido en esta recepción. */
  @IsOptional()
  @IsBoolean()
  generatePayable?: boolean;

  /** Vencimiento de la CxP (si se genera). Por defecto, 30 días. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate debe ser YYYY-MM-DD' })
  dueDate?: string;

  @IsOptional()
  @IsString()
  docNumber?: string;
}
