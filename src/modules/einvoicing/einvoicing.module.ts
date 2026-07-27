import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
} from './infrastructure/schemas/electronic-document.schema';
import {
  Counter,
  CounterSchema,
} from '../sales/infrastructure/schemas/counter.schema';
import { EinvoicingService } from './application/einvoicing.service';
import { EinvoicingController } from './infrastructure/einvoicing.controller';
import { SalesModule } from '../sales/sales.module';
import { SedesModule } from '../sedes/sedes.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ElectronicDocument.name, schema: ElectronicDocumentSchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
    SalesModule,
    SedesModule,
  ],
  controllers: [EinvoicingController],
  providers: [EinvoicingService],
  exports: [EinvoicingService],
})
export class EinvoicingModule {}
