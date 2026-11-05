import { IsEmail, IsOptional, MaxLength } from 'class-validator';

/** Correo del destinatario; sin él se usa el del adquiriente del documento. */
export class EnviarCorreoDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
