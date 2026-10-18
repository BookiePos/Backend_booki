import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Cuerpo de `POST /auth/register/confirm`: el token del correo, fuera de la URL. */
export class ConfirmRegisterDto {
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;
}

/** Cuerpo de `POST /auth/register/resend`. */
export class ResendRegisterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
