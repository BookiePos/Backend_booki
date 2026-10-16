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

/** Bucket privado por defecto: lo que no debe leerse sin pasar por el API. */
const DEFAULT_PRIVATE_BUCKET = 'bookipos-privado';

/**
 * Vida de una URL firmada. Alcanza para revisar una factura con calma; si
 * vence, la pantalla vuelve a pedir la factura y trae otra.
 */
export const FIRMA_SEGUNDOS = 60 * 60;

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
 * Hay dos buckets. El PÚBLICO guarda las fotos de productos: las URL se
 * guardan en la base y se muestran en el POS sin firmar nada. El PRIVADO guarda
 * las facturas de compra (ítem 3.8): traen NIT, precios y condiciones del
 * proveedor, así que nadie las lee sin pasar por el API, que entrega una URL
 * firmada que vence. Las facturas subidas antes siguen en el público.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger('StorageService');
  private readonly client?: SupabaseClient;
  private readonly bucket: string;
  private readonly privateBucket: string;
  /** El bucket privado se crea la primera vez que hace falta. */
  private privadoListo?: Promise<void>;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.bucket =
      this.config.get<string>('SUPABASE_STORAGE_BUCKET') ?? DEFAULT_BUCKET;
    this.privateBucket =
      this.config.get<string>('SUPABASE_PRIVATE_BUCKET') ??
      DEFAULT_PRIVATE_BUCKET;

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
   * Sube el archivo al bucket privado. No devuelve URL: para mostrarlo se
   * firma al responder (`firmarUrls`), para leerlo se descarga con la llave.
   */
  async uploadPrivado(
    pathname: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ pathname: string }> {
    const client = this.requireClient();
    await this.asegurarBucketPrivado(client);
    const { error } = await client.storage
      .from(this.privateBucket)
      .upload(pathname, body, { contentType, upsert: true });
    if (error) {
      this.logger.error(`Fallo subiendo "${pathname}" (privado): ${error.message}`);
      throw new ServiceUnavailableException(
        'No se pudo guardar el archivo. Inténtalo de nuevo en un momento.',
      );
    }
    return { pathname };
  }

  /**
   * URLs firmadas de varios archivos privados, en una sola llamada (un listado
   * trae hasta 200 facturas). Una ruta que no se pudo firmar no aparece: la
   * pantalla muestra la factura sin imagen en vez de fallar entera.
   */
  async firmarUrls(
    pathnames: string[],
    segundos = FIRMA_SEGUNDOS,
  ): Promise<Record<string, string>> {
    if (!this.client || pathnames.length === 0) return {};
    const { data, error } = await this.client.storage
      .from(this.privateBucket)
      .createSignedUrls(pathnames, segundos);
    if (error || !data) {
      this.logger.warn(`No se pudieron firmar ${pathnames.length} URL: ${error?.message}`);
      return {};
    }
    const firmadas: Record<string, string> = {};
    for (const item of data) {
      if (item.path && item.signedUrl) firmadas[item.path] = item.signedUrl;
    }
    return firmadas;
  }

  /** Descarga un archivo privado con la llave del servidor. */
  async descargarPrivado(
    pathname: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const client = this.requireClient();
    const { data, error } = await client.storage
      .from(this.privateBucket)
      .download(pathname);
    if (error || !data) {
      this.logger.error(`No se pudo descargar "${pathname}": ${error?.message}`);
      throw new ServiceUnavailableException('No se pudo recuperar el archivo.');
    }
    return {
      buffer: Buffer.from(await data.arrayBuffer()),
      mimetype: data.type || 'application/octet-stream',
    };
  }

  /**
   * Crea el bucket privado si no existe, una vez por instancia. Así desplegar
   * no exige un paso a mano en Supabase; si ya existe, no toca su
   * configuración.
   */
  private asegurarBucketPrivado(client: SupabaseClient): Promise<void> {
    this.privadoListo ??= (async () => {
      const { data } = await client.storage.getBucket(this.privateBucket);
      if (data) {
        if (data.public) {
          this.logger.error(
            `El bucket "${this.privateBucket}" es público: las facturas quedarían expuestas.`,
          );
          throw new ServiceUnavailableException(
            'El almacenamiento privado está mal configurado.',
          );
        }
        return;
      }
      const { error } = await client.storage.createBucket(this.privateBucket, {
        public: false,
      });
      if (error && !/already exists/i.test(error.message)) {
        throw new ServiceUnavailableException(
          'No se pudo preparar el almacenamiento privado.',
        );
      }
    })().catch((err: unknown) => {
      // Un fallo no queda cacheado: el siguiente intento vuelve a probar.
      this.privadoListo = undefined;
      throw err;
    });
    return this.privadoListo;
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
  async remove(
    pathname: string,
    opciones: { privado?: boolean } = {},
  ): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.storage
      .from(opciones.privado ? this.privateBucket : this.bucket)
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
