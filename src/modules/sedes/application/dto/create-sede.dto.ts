import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreateSedeDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  /** Nombre comercial / marca del negocio (título de la factura). */
  @IsOptional()
  @IsString()
  businessName?: string;

  @IsOptional()
  @IsString()
  address?: string;

  /** NIT / identificación tributaria del negocio. */
  @IsOptional()
  @IsString()
  nit?: string;

  /** Teléfono de contacto del negocio. */
  @IsOptional()
  @IsString()
  phone?: string;

  /** Leyenda legal al pie de la factura. */
  @IsOptional()
  @IsString()
  legalNote?: string;
}
