import { IsIn } from 'class-validator';

export class AjusteNominaDto {
  @IsIn(['reemplazar', 'eliminar'])
  tipoNota!: 'reemplazar' | 'eliminar';
}
