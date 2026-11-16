import { Equals } from 'class-validator';

/**
 * Confirmación explícita del dueño: afirma que el portal de la DIAN ya muestra el
 * software como habilitado. Solo vale `true`: un cuerpo vacío no confirma nada.
 */
export class ConfirmarHabilitacionDto {
  @Equals(true, { message: 'Debes confirmar que el portal de la DIAN ya muestra el software como habilitado.' })
  confirmo!: boolean;
}
