import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsMongoId,
  IsNumber,
  IsPositive,
  ValidateNested,
} from 'class-validator';

/** Una línea del carrito que se está cobrando. */
export class PackagingSuggestionLineDto {
  @IsMongoId()
  productId!: string;

  @IsNumber()
  @IsPositive()
  qty!: number;
}

/**
 * Qué hay en el carrito, para preguntar con qué empaque suele salir.
 *
 * Va por POST y no por GET con la lista en la URL porque un carrito de quince
 * productos no cabe cómodo en una query string; no escribe nada.
 */
export class PackagingSuggestionDto {
  @IsMongoId()
  sedeId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PackagingSuggestionLineDto)
  lines!: PackagingSuggestionLineDto[];
}
