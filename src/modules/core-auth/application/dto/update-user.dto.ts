import {
  IsArray,
  IsBoolean,
  IsMongoId,
  IsOptional,
  IsString,
  IsStrongPassword,
  MinLength,
} from 'class-validator';
import { POLITICA_CONTRASENA } from './password-policy';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraPermissions?: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  sedeIds?: string[];

  /** Solo si se cambia. Misma política que el registro (ítem 4.9). */
  @IsOptional()
  @IsString()
  @IsStrongPassword(POLITICA_CONTRASENA)
  password?: string;
}
