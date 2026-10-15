import { IsString, IsStrongPassword, MinLength } from 'class-validator';
import { POLITICA_CONTRASENA } from './password-policy';

export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @IsStrongPassword(POLITICA_CONTRASENA)
  password!: string;
}
