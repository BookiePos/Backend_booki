import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreateInvitationDto {
  @IsEmail()
  email!: string;

  /** Key del rol (validado contra la BD en el servicio). */
  @IsString()
  @MinLength(1)
  role!: string;
}
