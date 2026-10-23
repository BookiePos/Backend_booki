import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MAX_IMPORT_CHARS,
  MAX_IMPORT_ORDERS,
  PLATFORM_CODES,
  PlatformCode,
} from '../../domain/platform-orders';

/** Vista previa e importación comparten cuerpo: la sede, la plataforma y el CSV como texto. */
export class ImportPlatformOrdersDto {
  @IsMongoId()
  sedeId!: string;

  @IsIn(PLATFORM_CODES as readonly string[])
  platform!: PlatformCode;

  /** Contenido del CSV del portal de aliados. */
  @IsString()
  @MaxLength(MAX_IMPORT_CHARS)
  csv!: string;
}

export class CreatePlatformSettlementDto {
  @IsMongoId()
  sedeId!: string;

  @IsIn(PLATFORM_CODES as readonly string[])
  platform!: PlatformCode;

  /** Pedidos que esta liquidación cobra. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_IMPORT_ORDERS * 5)
  @IsMongoId({ each: true })
  saleIds!: string[];

  /** Lo que la plataforma consignó (neto), en pesos enteros. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  received!: number;

  /** Comisión y ajustes, sin IVA. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  commission!: number;

  /** IVA de la comisión, si el negocio lo descuenta. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  commissionIva?: number;

  /** Retención en la fuente que practicó la plataforma. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  retefuente?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reteIca?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reteIva?: number;

  /**
   * Diferencia entre lo que la plataforma cobró al cliente (su menú) y el precio
   * del POS, con signo: positivo si cobró más, negativo si cobró menos.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ajustePrecio?: number;

  /** Fecha de la consignación; hoy por omisión. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe ser YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}
