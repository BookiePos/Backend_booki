import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Conteo físico de una sede: lo que de verdad hay en los estantes.
 *
 * Es lo que se hace un domingo al cerrar, con la planilla en la mano y
 * recorriendo la bodega. No es una entrada de mercancía ni una salida: es
 * decir "aquí hay 40" y que el sistema se acomode, sume o reste.
 *
 * Por eso NO se puede hacer con `stock/import`, que suma cada fila como
 * entrada: usarlo para contar duplica el inventario.
 */
export class StockCountRow {
  @IsMongoId()
  productId!: string;

  /** Lo que se contó en el estante. Cero es un valor válido: se agotó. */
  @IsNumber()
  @Min(0)
  counted!: number;

  /**
   * Lo que el sistema decía cuando se generó la planilla.
   *
   * No manda sobre el ajuste —la verdad es el estante— pero si para cuando se
   * aplica la existencia ya no es esta, algo se movió mientras se contaba (una
   * venta, un traslado) y esa fila se reporta aparte para que alguien la mire.
   */
  @IsOptional()
  @IsNumber()
  expected?: number;
}

export class StockCountDto {
  @IsMongoId()
  sedeId!: string;

  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StockCountRow)
  rows!: StockCountRow[];

  /** Queda en cada movimiento del kardex: "conteo del domingo 12". */
  @IsOptional()
  @IsString()
  note?: string;
}

/** Resumen de un conteo aplicado. */
export interface StockCountResult {
  /** Filas recibidas. */
  total: number;
  /** Filas que movieron existencias. */
  adjusted: number;
  /** Filas que ya cuadraban: se contaron y no había nada que corregir. */
  unchanged: number;
  /** Unidades que aparecieron de más y que faltaban, y su costo. */
  addedQty: number;
  removedQty: number;
  addedValue: number;
  removedValue: number;
  /** Filas cuya existencia cambió entre generar la planilla y aplicarla. */
  moved: {
    productId: string;
    name: string;
    expected: number;
    actual: number;
  }[];
  errors: { productId: string; name: string; message: string }[];
}
