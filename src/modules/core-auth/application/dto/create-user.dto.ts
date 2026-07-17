import {
  IsArray,
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  // La validez del rol se comprueba contra la DB en el servicio.
  @IsString()
  role!: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  sedeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraPermissions?: string[];
}
