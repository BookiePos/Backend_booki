import { IsOptional, IsString } from 'class-validator';

export class RefreshDto {
  // Opcional: el refresh token viaja normalmente en la cookie HttpOnly.
  // Se mantiene en el body como respaldo para clientes aún no migrados.
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
