import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  CATEGORY_KINDS,
  CATEGORY_AUTO_SOURCES,
  CategoryAutoSource,
  CategoryKind,
} from '../../domain/finance.constants';

/** Crea una categoría financiera (siempre `system:false`). */
export class CreateCategoryDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(CATEGORY_KINDS as readonly string[])
  kind!: CategoryKind;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  accountCode?: string;

  @IsOptional()
  @IsIn(CATEGORY_AUTO_SOURCES as readonly string[])
  autoSource?: CategoryAutoSource;
}

/** Actualiza una categoría (merge parcial). */
export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(CATEGORY_KINDS as readonly string[])
  kind?: CategoryKind;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  accountCode?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
