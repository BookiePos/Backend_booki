import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreateSaleDto } from './create-sale.dto';
import { OFFLINE_BLOCK_MAX } from '../../domain/offline-sales';

/** Pide un bloque de consecutivos de contingencia para vender sin red (6.3). */
export class ReserveOfflineNumbersDto {
  @IsMongoId()
  sedeId!: string;

  /** Id del terminal que generó el navegador. Solo trazabilidad. */
  @IsString()
  @MaxLength(64)
  @Matches(/^[\w-]+$/, { message: 'deviceId inválido' })
  deviceId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(OFFLINE_BLOCK_MAX)
  count?: number;
}

/** Una venta cobrada sin red que el terminal envía al volver la conexión. */
export class SyncOfflineSaleDto {
  /** UUID que el terminal le puso al cobrar: la llave de idempotencia. */
  @IsUUID('4')
  offlineId!: string;

  @IsMongoId()
  reservationId!: string;

  /** Consecutivo reservado que salió impreso en el comprobante. */
  @Matches(/^FVC-\d{6,}$/, { message: 'saleNumber no es de la serie de contingencia' })
  saleNumber!: string;

  /** Cuándo se cobró, según el reloj del terminal (ISO 8601). */
  @IsISO8601({ strict: true })
  soldAt!: string;

  /** Lo que pagó el cliente según el comprobante (total + propina), en COP. */
  @IsInt()
  @Min(0)
  expectedGrandTotal!: number;

  /**
   * El turno de la reserva ya se cerró y quien sincroniza decide registrar la
   * venta en el turno abierto ahora (desde la bandeja de conflictos).
   */
  @IsOptional()
  @IsBoolean()
  useOpenShift?: boolean;

  @IsDefined()
  @ValidateNested()
  @Type(() => CreateSaleDto)
  sale!: CreateSaleDto;
}
