/**
 * Reglas de la imagen de un producto vendible. Puro dominio: sin Nest y sin
 * Mongoose, para poder probarlo y reusarlo desde donde haga falta.
 */

/**
 * Tamaño máximo aceptado, 4 MB.
 *
 * El límite real no es nuestro: el API corre en funciones de Vercel, que
 * rechazan cuerpos de más de 4.5 MB antes de que el handler llegue a
 * ejecutarse. Cortamos por debajo para poder devolver un error explicable en
 * vez de un 413 opaco de la plataforma. De todos modos el navegador reescala
 * antes de subir, así que una foto normal ronda los 200 KB.
 */
export const PRODUCT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Formatos aceptados y la extensión con la que se guardan. Solo mapas de
 * imagen: nada de SVG, que es un documento con scripts y se serviría desde un
 * dominio público con la sesión de nadie, pero tampoco hace falta.
 */
export const PRODUCT_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** Etiqueta legible de los formatos aceptados, para los mensajes de error. */
export const PRODUCT_IMAGE_TYPES_LABEL = 'JPG, PNG, WebP o AVIF';

/** Extensión con la que guardar un tipo MIME, o `null` si no se acepta. */
export function imageExtension(mimetype: string): string | null {
  return PRODUCT_IMAGE_TYPES[mimetype.toLowerCase()] ?? null;
}
