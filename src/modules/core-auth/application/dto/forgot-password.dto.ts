import { IsString, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  /** Correo o nombre de usuario, igual que en el login. */
  @IsString()
  @MinLength(1)
  email!: string;
}
