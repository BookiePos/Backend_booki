import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { del, put } from '@vercel/blob';

/** Archivo subido y ya guardado. `pathname` es lo que hace falta para borrarlo. */
export interface StoredFile {
  url: string;
  pathname: string;
}

/**
 * Almacenamiento de archivos públicos en Vercel Blob.
 *
 * Va en `shared/` y no dentro del catálogo porque el problema —guardar un
 * archivo y poder borrarlo después— no es del catálogo: el logo del negocio o
 * un adjunto de gasto van a querer lo mismo.
 *
 * El token (`BLOB_READ_WRITE_TOKEN`) es de lectura Y escritura sobre todo el
 * store: vive solo aquí, nunca viaja al navegador. Por eso el archivo entra por
 * el API en vez de subirse directo desde el cliente.
 */
@Injectable()
export class BlobStorageService {
  private readonly logger = new Logger('BlobStorageService');
  private readonly token?: string;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.get<string>('BLOB_READ_WRITE_TOKEN');
    if (!this.token) {
      this.logger.warn(
        'BLOB_READ_WRITE_TOKEN no configurada: subir imágenes devolverá 503.',
      );
    }
  }

  /** ¿Hay almacenamiento configurado? */
  get enabled(): boolean {
    return Boolean(this.token);
  }

  /**
   * Sube el archivo y devuelve su URL pública.
   *
   * `addRandomSuffix: false` porque la ruta ya la construye quien llama con su
   * propio azar: así el nombre es predecible en los logs y no se acumulan copias
   * silenciosas si se reintenta la misma subida.
   */
  async upload(
    pathname: string,
    body: Buffer,
    contentType: string,
  ): Promise<StoredFile> {
    const token = this.requireToken();
    try {
      const blob = await put(pathname, body, {
        access: 'public',
        contentType,
        addRandomSuffix: false,
        token,
      });
      return { url: blob.url, pathname: blob.pathname };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo subiendo "${pathname}": ${message}`);
      throw new ServiceUnavailableException(
        'No se pudo guardar el archivo. Inténtalo de nuevo en un momento.',
      );
    }
  }

  /**
   * Borra un archivo. **Best-effort a propósito**: se llama después de haber
   * guardado ya el cambio en la base, así que si el borrado falla lo peor que
   * queda es un archivo huérfano en el store —molesto, no incorrecto—, y hacer
   * fallar la petición por eso sería peor para quien está editando.
   */
  async remove(pathname: string): Promise<void> {
    if (!this.token) return;
    try {
      await del(pathname, { token: this.token });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`No se pudo borrar el blob "${pathname}": ${message}`);
    }
  }

  private requireToken(): string {
    if (!this.token) {
      throw new ServiceUnavailableException(
        'El almacenamiento de imágenes no está configurado en este entorno.',
      );
    }
    return this.token;
  }
}
