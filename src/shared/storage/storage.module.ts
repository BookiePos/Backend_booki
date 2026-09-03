import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Almacenamiento de archivos (Supabase Storage). Se importa donde haga falta
 * en vez de ser `@Global()`: así se ve en el módulo qué partes de la app
 * escriben archivos, que no deberían ser muchas.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
