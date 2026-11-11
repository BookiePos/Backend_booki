import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';

/** Filtros de la bandeja global de devoluciones pendientes (Fase 6D, deuda). */
export class ListPendingReturnsQueryDto {
  /** Una sede concreta; sin ella, todas las sedes a las que el usuario tiene acceso. */
  @IsOptional()
  @IsMongoId()
  sedeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
