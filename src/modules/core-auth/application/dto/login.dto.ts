import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  /** Correo o nombre de usuario. */
  @IsString()
  @MinLength(1)
  email!: string;

  /**
   * Sin mínimo de longitud a propósito: aquí solo se comprueba una credencial
   * ya existente. Exigir 6 caracteres devolvía un 400 ("password must be longer
   * than or equal to 6 characters") a quien se equivocaba al teclear, en vez
   * del 401 "Credenciales inválidas" que corresponde.
   */
  @IsString()
  @MinLength(1)
  password!: string;
}
