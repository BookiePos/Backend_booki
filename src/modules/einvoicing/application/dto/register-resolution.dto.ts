import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Alta o renovación de una resolución de numeración de la DIAN.
 *
 * Todo es opcional salvo por lo que exige el propio negocio: se permite
 * guardar una resolución a medias mientras llegan los datos de la DIAN, y la
 * pantalla de control avisa de lo que falte. Lo que NO se permite es emitir con
 * ella incompleta, que se valida al facturar.
 */
export class RegisterResolutionDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  numero?: string;

  @IsOptional()
  @Matches(YYYYMMDD, { message: 'fechaResolucion debe ser YYYY-MM-DD' })
  fechaResolucion?: string;

  /** Hasta 4 caracteres alfanuméricos, según la norma de numeración. */
  @IsOptional()
  @IsString()
  @MaxLength(4)
  prefijo?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  rangoDesde?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  rangoHasta?: number;

  @IsOptional()
  @Matches(YYYYMMDD, { message: 'vigenciaDesde debe ser YYYY-MM-DD' })
  vigenciaDesde?: string;

  @IsOptional()
  @Matches(YYYYMMDD, { message: 'vigenciaHasta debe ser YYYY-MM-DD' })
  vigenciaHasta?: string;

  /** Si no viene, se conserva la que ya tuviera la sede. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  claveTecnica?: string;

  /**
   * Número por el que arranca el consecutivo.
   *
   * Se pregunta explícitamente porque es lo que descuadraba la numeración al
   * renovar: al estrenar resolución normalmente es el inicio del rango, pero
   * quien migra desde otro sistema necesita continuar donde venía.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  empezarEn?: number;
}
