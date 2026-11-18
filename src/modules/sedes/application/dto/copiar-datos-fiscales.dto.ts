import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsMongoId } from 'class-validator';

/** Sedes a las que se copian los datos del RUT de la sede de origen. */
export class CopiarDatosFiscalesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  destinos!: string[];
}
