import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Cuerpo de `POST /auth/register/confirm`: el token del correo, fuera de la URL. */
export class ConfirmRegisterDto {
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;

  /** La del formulario de registro: prueba que confirma quien se registró. */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

/** Cuerpo de `POST /auth/register/resend`. */
export class ResendRegisterDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
