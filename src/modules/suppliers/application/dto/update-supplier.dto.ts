import {
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsEmail } from 'class-validator';
import {
  SUPPLIER_DOC_TYPES,
  SupplierDocType,
} from '../../infrastructure/schemas/supplier.schema';

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsIn(SUPPLIER_DOC_TYPES as readonly string[])
  docType?: SupplierDocType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  docNumber?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  /** Cadena vacía = quitar email (evita fallar @IsEmail al limpiar). */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
