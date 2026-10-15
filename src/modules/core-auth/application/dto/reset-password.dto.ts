import { IsString, IsStrongPassword } from 'class-validator';
import { POLITICA_CONTRASENA } from './password-policy';

export class ResetPasswordDto {
  /** Nueva contraseña. Misma política que el registro (ítem 4.9). */
  @IsString()
  @IsStrongPassword(POLITICA_CONTRASENA)
  password!: string;
}
