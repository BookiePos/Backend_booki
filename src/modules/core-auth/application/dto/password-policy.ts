import type { IsStrongPasswordOptions } from 'class-validator';

/**
 * Política de contraseña única de la API: registro, alta y edición de usuario,
 * aceptación de invitación y recuperación (ítem 4.9). Vivía copiada en cada
 * DTO y el de recuperación se quedó en 6 caracteres: "olvidar" la contraseña
 * era la forma de saltarse la política. Un solo sitio evita que vuelvan a
 * divergir; el frontend replica estas reglas en sus formularios.
 */
export const POLITICA_CONTRASENA: IsStrongPasswordOptions = {
  minLength: 8,
  minLowercase: 1,
  minUppercase: 1,
  minNumbers: 1,
  minSymbols: 1,
};
