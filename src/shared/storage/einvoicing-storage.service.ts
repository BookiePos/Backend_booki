import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StorageService } from './storage.service';
import { TenantContext } from '../tenancy/tenant-context';

/** Artefactos de un documento electrónico que se pueden entregar al usuario. */
export type TipoArtefactoFe = 'xml' | 'pdf' | 'zip';

const CONTENT_TYPE: Record<TipoArtefactoFe, string> = {
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/** Vida por defecto de la URL firmada de un XML/PDF/ZIP: se pide al hacer clic. */
export const FE_FIRMA_SEGUNDOS = 5 * 60;
/** Tope: ni quien llama puede pedir una URL que viva más que esto. */
export const FE_FIRMA_MAX_SEGUNDOS = 15 * 60;

/** Identificador de empresa, emisor o documento: un solo segmento, sin separadores. */
const SEGMENTO = /^[A-Za-z0-9_-]{1,64}$/;
/** Nombre del archivo del certificado: un segmento, termina en .p12. */
const NOMBRE_P12 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}\.p12$/i;

/**
 * Almacenamiento privado de la factura electrónica (Supabase, bucket privado).
 *
 *   einvoicing/<empresa>/<emisor>/cert/<archivo>.p12
 *   einvoicing/<empresa>/<emisor>/<docId>/documento.{xml,pdf,zip}
 *
 * Reglas:
 * - La empresa SALE del `TenantContext`, nunca de un parámetro: quien llama no
 *   puede apuntar a la carpeta de otra empresa.
 * - Cada segmento de la ruta se valida contra una lista cerrada de caracteres;
 *   `..`, `/`, `\`, puntos solos y vacíos no pasan (path traversal).
 * - El .p12 NO tiene URL firmada: ni siquiera existe el método. Solo se lee
 *   desde el servidor (`leerCertificado`) para firmar.
 * - XML, PDF y ZIP se entregan con una URL firmada de vida corta.
 */
@Injectable()
export class EinvoicingStorageService {
  constructor(private readonly storage: StorageService) {}

  /** Guarda (o reemplaza) el .p12 de un emisor. Devuelve la ruta guardada. */
  async guardarCertificado(
    emisorId: string,
    nombreArchivo: string,
    contenido: Buffer,
  ): Promise<{ pathname: string }> {
    const pathname = this.rutaCertificado(emisorId, nombreArchivo);
    return this.storage.uploadPrivado(
      pathname,
      contenido,
      'application/x-pkcs12',
    );
  }

  /** Lee el .p12 desde el servidor. No hay equivalente con URL. */
  async leerCertificado(
    emisorId: string,
    nombreArchivo: string,
  ): Promise<Buffer> {
    const { buffer } = await this.storage.descargarPrivado(
      this.rutaCertificado(emisorId, nombreArchivo),
    );
    return buffer;
  }

  /** Borra un .p12 (best-effort, como `StorageService.remove`). */
  async borrarCertificado(
    emisorId: string,
    nombreArchivo: string,
  ): Promise<void> {
    await this.storage.remove(this.rutaCertificado(emisorId, nombreArchivo), {
      privado: true,
    });
  }

  /** Guarda el XML, PDF o ZIP de un documento. Devuelve la ruta guardada. */
  async guardarArtefacto(
    emisorId: string,
    docId: string,
    tipo: TipoArtefactoFe,
    contenido: Buffer,
  ): Promise<{ pathname: string }> {
    const pathname = this.rutaArtefacto(emisorId, docId, tipo);
    return this.storage.uploadPrivado(pathname, contenido, CONTENT_TYPE[tipo]);
  }

  /** Lee un artefacto desde el servidor (p. ej. para reenviar el mismo XML). */
  async leerArtefacto(
    emisorId: string,
    docId: string,
    tipo: TipoArtefactoFe,
  ): Promise<Buffer> {
    const { buffer } = await this.storage.descargarPrivado(
      this.rutaArtefacto(emisorId, docId, tipo),
    );
    return buffer;
  }

  /**
   * URL firmada de vida corta para descargar el XML, PDF o ZIP. Solo acepta
   * `TipoArtefactoFe`: el certificado no puede pasar por aquí.
   */
  async urlFirmadaArtefacto(
    emisorId: string,
    docId: string,
    tipo: TipoArtefactoFe,
    segundos: number = FE_FIRMA_SEGUNDOS,
  ): Promise<string> {
    const pathname = this.rutaArtefacto(emisorId, docId, tipo);
    const vida = Math.min(
      Math.max(Math.floor(segundos) || FE_FIRMA_SEGUNDOS, 1),
      FE_FIRMA_MAX_SEGUNDOS,
    );
    if (!this.storage.enabled) {
      throw new ServiceUnavailableException(
        'El almacenamiento de archivos no está configurado en este entorno.',
      );
    }
    const firmadas = await this.storage.firmarUrls([pathname], vida);
    const url = firmadas[pathname];
    if (!url) throw new NotFoundException('El archivo no está disponible.');
    return url;
  }

  /** Prefijo del emisor dentro de la empresa activa (del TenantContext). */
  private prefijoEmisor(emisorId: string): string {
    const empresa = TenantContext.currentOrThrow().businessId;
    return [
      'einvoicing',
      this.segmento(empresa, 'empresa'),
      this.segmento(emisorId, 'emisor'),
    ].join('/');
  }

  private rutaCertificado(emisorId: string, nombreArchivo: string): string {
    if (typeof nombreArchivo !== 'string' || !NOMBRE_P12.test(nombreArchivo)) {
      throw new BadRequestException('Nombre de certificado no válido.');
    }
    return `${this.prefijoEmisor(emisorId)}/cert/${nombreArchivo}`;
  }

  private rutaArtefacto(
    emisorId: string,
    docId: string,
    tipo: TipoArtefactoFe,
  ): string {
    if (!Object.prototype.hasOwnProperty.call(CONTENT_TYPE, tipo)) {
      throw new BadRequestException('Tipo de archivo no permitido.');
    }
    return `${this.prefijoEmisor(emisorId)}/${this.segmento(docId, 'documento')}/documento.${tipo}`;
  }

  /** Un solo segmento de ruta, de una lista cerrada de caracteres. */
  private segmento(valor: unknown, nombre: string): string {
    if (typeof valor !== 'string' || !SEGMENTO.test(valor)) {
      throw new BadRequestException(`Identificador de ${nombre} no válido.`);
    }
    return valor;
  }
}
