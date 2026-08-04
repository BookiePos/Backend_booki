import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  /** Correo o nombre de usuario. */
  @IsString()
  @MinLength(1)
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
