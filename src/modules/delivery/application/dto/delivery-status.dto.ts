import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  DELIVERY_STATUSES,
  DeliveryStatus,
} from '../../domain/delivery.constants';

export class UpdateDeliveryStatusDto {
  @IsIn(DELIVERY_STATUSES as readonly string[])
  status!: DeliveryStatus;

  /** Se puede asignar o cambiar el repartidor en el mismo paso. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courier?: string;

  /**
   * Por qué no se pudo entregar. Obligatorio al marcar fallido: sin el motivo,
   * un domicilio fallido es un dato que no sirve para nada — nadie puede saber
   * si fue la dirección, el cliente o el repartidor.
   */
  @IsOptional()
  @IsString()
  @MaxLength(240)
  failureReason?: string;
}
