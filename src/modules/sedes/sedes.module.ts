import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sede, SedeSchema } from './infrastructure/schemas/sede.schema';
import { SedesService } from './application/sedes.service';
import { SedesController } from './infrastructure/sedes.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Sede.name, schema: SedeSchema }]),
  ],
  controllers: [SedesController],
  providers: [SedesService],
  exports: [SedesService],
})
export class SedesModule {}
