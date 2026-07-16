import {
  IsArray,
  IsEmail,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ROLE_VALUES, Role } from '../../domain/roles';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(ROLE_VALUES)
  role!: Role;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  sedeIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraPermissions?: string[];
}
