import { IsInt, Max, Min } from 'class-validator';

/** Compra única de paquetes de 1.000 documentos (contra la tarjeta guardada). */
export class PurchaseDocsDto {
  @IsInt()
  @Min(1)
  @Max(100)
  packages!: number;
}
