import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { Sede, SedeSchema } from './infrastructure/schemas/sede.schema';
import { SedesService } from './application/sedes.service';
import { SedesController } from './infrastructure/sedes.controller';

@Module({
  imports: [
    TenantMongooseModule.forFeature([{ name: Sede.name, schema: SedeSchema }]),
  ],
  controllers: [SedesController],
  providers: [SedesService],
  exports: [SedesService],
})
export class SedesModule {}
