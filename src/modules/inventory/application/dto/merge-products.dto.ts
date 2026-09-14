import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId } from 'class-validator';

/** Productos que se fusionan en el de la URL (el que se queda). */
export class MergeProductsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  sourceIds!: string[];
}
