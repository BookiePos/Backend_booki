import {
  IsArray,
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  IsStrongPassword,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { POLITICA_CONTRASENA } from './password-policy';

export class CreateUserDto {
  // Email opcional: si no se pasa, se sintetiza a partir del username. Debe
  // haber al menos uno (email o username); el servicio lo valida.
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @IsEmail()
  email?: string;

  /**
   * Nombre de usuario para iniciar sesión (alternativa al email). 3-30
   * caracteres: letras, números, punto, guion y guion bajo.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @Matches(/^[a-zA-Z0-9._-]{3,30}$/, {
    message:
      'El usuario debe tener 3-30 caracteres: letras, números, punto, guion o guion bajo',
  })
  username?: string;

  @IsString()
  @IsStrongPassword(POLITICA_CONTRASENA)
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
