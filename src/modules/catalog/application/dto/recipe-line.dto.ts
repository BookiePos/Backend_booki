import { IsMongoId, IsNumber, IsPositive } from 'class-validator';

export class RecipeLineDto {
  /** Ítem de inventario que se consume. */
  @IsMongoId()
  productId!: string;

  /** Cantidad consumida por unidad vendida (en la unidad del ítem). */
  @IsNumber()
  @IsPositive()
  qty!: number;
}
