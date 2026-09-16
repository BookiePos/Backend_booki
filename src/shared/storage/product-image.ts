/**
 * Reglas de la foto de un producto. Puro dominio: sin Nest y sin Mongoose.
 *
 * Vive en `shared/storage` y no dentro del catálogo porque ya no es solo del
 * catálogo: la foto del vendible y la del empaque en inventario tienen el mismo
 * límite, los mismos formatos y el mismo motivo para tenerlos. Duplicar estas
 * constantes era garantizar que un día se aceptara en un sitio lo que el otro
 * rechaza.
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

/**
 * Lo que necesitamos de un archivo subido. Se declara aquí en vez de usar
 * `Express.Multer.File` para no añadir `@types/multer` al proyecto por cuatro
 * campos: multer viene con `@nestjs/platform-express`, sus tipos no.
 */
export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}
