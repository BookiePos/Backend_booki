import {
  IsArray,
  IsBoolean,
  IsMongoId,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

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

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;
}
