import { Module } from '@nestjs/common';
import { BlobStorageService } from './blob-storage.service';

/**
 * Almacenamiento de archivos (Vercel Blob). Se importa donde haga falta en vez
 * de ser `@Global()`: así se ve en el módulo qué partes de la app escriben
 * archivos, que no deberían ser muchas.
 */
@Module({
  providers: [BlobStorageService],
  exports: [BlobStorageService],
})
export class StorageModule {}
