import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { OrderLineInputDto } from './create-order.dto';

/** Edición de una cuenta abierta: etiqueta, nota y/o reemplazo de líneas. */
export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** Si viene, reemplaza por completo las líneas de la cuenta. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines?: OrderLineInputDto[];
}
