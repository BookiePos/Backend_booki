import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  /** Nueva contraseña. Mismo mínimo que al crear un usuario. */
  @IsString()
  @MinLength(6)
  password!: string;
}
