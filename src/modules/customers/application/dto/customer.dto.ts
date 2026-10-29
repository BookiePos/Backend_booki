import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  CUSTOMER_DOC_TYPES,
  CustomerDocType,
} from '../../infrastructure/schemas/customer.schema';

import {
  DIAN_DOC_TYPE_CODES,
  REGIMENES,
  RESPONSABILIDADES_FISCALES,
  TIPOS_PERSONA,
} from '../../domain/datos-fiscales';

/**
 * Datos fiscales del adquiriente. En la edición, la cadena vacía los borra
 * (por eso las validaciones se saltan el vacío).
 */
class DatosFiscalesDto {
  /** Código DIAN: 13 CC, 31 NIT, 22 CE, 41 pasaporte, 42 doc. extranjero… */
  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @IsIn(DIAN_DOC_TYPE_CODES)
  dianDocType?: string;

  /** Dígito de verificación del NIT. */
  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(/^\d$/, { message: 'El DV debe ser un solo dígito' })
  nitDv?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @IsIn(TIPOS_PERSONA)
  tipoPersona?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(RESPONSABILIDADES_FISCALES, { each: true })
  responsabilidadesFiscales?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @IsIn(REGIMENES)
  regimen?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(/^\d{5}$/, {
    message: 'El municipio debe ser el código DANE de 5 dígitos',
  })
  municipioDane?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @IsEmail()
  emailFacturacion?: string;
}

export class CreateCustomerDto extends DatosFiscalesDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsIn(CUSTOMER_DOC_TYPES)
  docType?: CustomerDocType;

  @IsString()
  @MinLength(1)
  docNumber!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  creditLimit?: number;

  /**
   * Lista de precios con la que se le cobra. Vacío = precio de mostrador.
   * Va como texto y no como @IsMongoId para que la cadena vacía pueda QUITAR
   * la lista; el servicio valida que sea un id de verdad.
   */
  @IsOptional()
  @IsString()
  priceListId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateCustomerDto extends DatosFiscalesDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  creditLimit?: number;

  /**
   * Lista de precios con la que se le cobra. Vacío = precio de mostrador.
   * Va como texto y no como @IsMongoId para que la cadena vacía pueda QUITAR
   * la lista; el servicio valida que sea un id de verdad.
   */
  @IsOptional()
  @IsString()
  priceListId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
