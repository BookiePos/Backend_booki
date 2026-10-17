import { IsBoolean, IsIn, IsMongoId, IsOptional } from 'class-validator';
import { TIPOS_PLANTILLA, type TipoPlantilla } from '../../domain/plantillas';

export class AplicarPlantillaDto {
  @IsIn(TIPOS_PLANTILLA as readonly string[])
  tipo!: TipoPlantilla;

  /** Sede que recibe las existencias y las mesas; sin ella, la primera a la que tenga acceso. */
  @IsOptional()
  @IsMongoId()
  sedeId?: string;

  /**
   * Confirmación explícita para cargar la plantilla en una empresa que YA tiene
   * productos propios. Sin ella, se rechaza: no se mezcla con lo que ya hay.
   */
  @IsOptional()
  @IsBoolean()
  confirmar?: boolean;
}
