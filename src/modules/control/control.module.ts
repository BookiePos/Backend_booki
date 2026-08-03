import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CONTROL_CONNECTION } from './domain/control.constants';
import {
  Business,
  BusinessSchema,
} from './infrastructure/schemas/business.schema';
import {
  BusinessDirectory,
  BusinessDirectorySchema,
} from './infrastructure/schemas/business-directory.schema';
import { BusinessService } from './application/business.service';
import { DirectoryService } from './application/directory.service';

/**
 * Control-plane: registro de empresas y directorio email → empresa. Sus modelos
 * viven en la conexión `control` (base `gocheck_control`), NO en la base de
 * ninguna empresa. Exporta los servicios para que la auth los use al registrar
 * y enrutar el login.
 */
@Module({
  imports: [
    MongooseModule.forFeature(
      [
        { name: Business.name, schema: BusinessSchema },
        { name: BusinessDirectory.name, schema: BusinessDirectorySchema },
      ],
      CONTROL_CONNECTION,
    ),
  ],
  providers: [BusinessService, DirectoryService],
  exports: [BusinessService, DirectoryService],
})
export class ControlModule {}
