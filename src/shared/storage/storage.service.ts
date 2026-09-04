import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Archivo subido y ya guardado. `pathname` es lo que hace falta para borrarlo. */
export interface StoredFile {
  url: string;
  pathname: string;
}

/** Bucket por defecto. Uno solo para todo, separado por prefijos de carpeta. */
const DEFAULT_BUCKET = 'bookipos';

/**
 * Almacenamiento de archivos públicos en Supabase Storage.
 *
 * Va en `shared/` y no dentro del catálogo porque el problema —guardar un
 * archivo y poder borrarlo después— no es del catálogo: la foto del producto y
 * la de la factura de compra quieren exactamente lo mismo.
 *
 * La `service_role key` salta las políticas RLS y puede escribir y borrar todo
 * el bucket: vive solo aquí, nunca viaja al navegador. Por eso el archivo entra
 * por el API en vez de subirse directo desde el cliente.
 *
 * El bucket es PÚBLICO en lectura, igual que antes: las URL se guardan en la
 * base y se muestran en el POS sin firmar nada. Lo que protege una factura no
 * es el bucket sino la ruta, que lleva un aleatorio de 12 hex por archivo.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger('StorageService');
  private readonly client?: SupabaseClient;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.bucket =
      this.config.get<string>('SUPABASE_STORAGE_BUCKET') ?? DEFAULT_BUCKET;

    if (!url || !key) {
      this.logger.warn(
        'SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY sin configurar: subir archivos devolverá 503.',
      );
      return;
    }
    // Sin sesión ni refresco: esto es un proceso de servidor con una llave fija,
    // no un usuario que inicia sesión. Guardar sesión aquí solo daría estado
    // compartido entre peticiones.
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** ¿Hay almacenamiento configurado? */
  get enabled(): boolean {
    return Boolean(this.client);
  }

  /**
   * Falla ya si no hay almacenamiento, antes de que quien llama comprometa
   * nada. Existe porque `upload()` es la última operación de flujos que primero
   * consumen cuota: sin esto, un 503 de configuración le cuesta al negocio un
   * escaneo por cada reintento. El mensaje vive aquí, no en cada llamador.
   */
  assertAvailable(): void {
    this.requireClient();
  }

  /**
   * Sube el archivo y devuelve su URL pública.
   *
   * `upsert: true` porque la ruta ya la construye quien llama con su propio
   * azar: no hay colisiones que temer, y así reintentar una subida que falló a
   * medias sobrescribe en vez de reventar con "el archivo ya existe".
   */
  async upload(
    pathname: string,
    body: Buffer,
    contentType: string,
  ): Promise<StoredFile> {
    const client = this.requireClient();
    const { error } = await client.storage
      .from(this.bucket)
      .upload(pathname, body, { contentType, upsert: true });

    if (error) {
      this.logger.error(`Fallo subiendo "${pathname}": ${error.message}`);
      throw new ServiceUnavailableException(
        'No se pudo guardar el archivo. Inténtalo de nuevo en un momento.',
      );
    }

    const { data } = client.storage.from(this.bucket).getPublicUrl(pathname);
    return { url: data.publicUrl, pathname };
  }

  /**
   * Borra un archivo. **Best-effort a propósito**: se llama después de haber
   * guardado ya el cambio en la base, así que si el borrado falla lo peor que
   * queda es un archivo huérfano en el bucket —molesto, no incorrecto—, y hacer
   * fallar la petición por eso sería peor para quien está editando.
   *
   * Las rutas de la época de Vercel Blob no existen aquí: borrarlas no es un
   * error, simplemente no encuentra nada. Sus URL viejas siguen sirviéndose
   * desde Blob mientras el store exista.
   */
  async remove(pathname: string): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.storage
      .from(this.bucket)
      .remove([pathname]);
    if (error) {
      this.logger.warn(
        `No se pudo borrar el archivo "${pathname}": ${error.message}`,
      );
    }
  }

  private requireClient(): SupabaseClient {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'El almacenamiento de archivos no está configurado en este entorno.',
      );
    }
    return this.client;
  }
}
