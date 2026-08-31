import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { StorageModule } from '../../shared/storage/storage.module';
import { ControlModule } from '../control/control.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { FinanceModule } from '../finance/finance.module';
import {
  InvoiceScan,
  InvoiceScanSchema,
} from './infrastructure/schemas/invoice-scan.schema';
import {
  SupplierItemAlias,
  SupplierItemAliasSchema,
} from './infrastructure/schemas/supplier-item-alias.schema';
import { InvoiceScanService } from './application/invoice-scan.service';
import { InvoiceMatchingService } from './application/invoice-matching.service';
import { QwenExtractorService } from './application/qwen-extractor.service';
import { GlmExtractorService } from './application/glm-extractor.service';
import { INVOICE_EXTRACTOR, InvoiceExtractor } from './application/invoice-extractor';
import { InvoiceScanController } from './infrastructure/invoice-scan.controller';

/**
 * Facturas de compra cargadas por foto.
 *
 * El módulo no reimplementa nada del circuito de compra: orquesta lo que ya
 * existe (compras, inventario, finanzas, proveedores) a partir de lo que el
 * modelo leyó y la persona aprobó.
 *
 * Qué modelo lee la foto lo decide `INVOICE_AI_PROVIDER` en tiempo de arranque.
 * Se resuelve por fábrica y no con un `if` dentro del servicio para que el
 * resto del código no sepa nunca con quién está hablando: cambiar de proveedor
 * es cambiar una variable de entorno y reiniciar.
 */
@Module({
  imports: [
    TenantMongooseModule.forFeature([
      { name: InvoiceScan.name, schema: InvoiceScanSchema },
      { name: SupplierItemAlias.name, schema: SupplierItemAliasSchema },
    ]),
    StorageModule,
    ControlModule,
    InventoryModule,
    SuppliersModule,
    PurchasingModule,
    FinanceModule,
  ],
  controllers: [InvoiceScanController],
  providers: [
    InvoiceScanService,
    InvoiceMatchingService,
    QwenExtractorService,
    GlmExtractorService,
    {
      provide: INVOICE_EXTRACTOR,
      inject: [ConfigService, QwenExtractorService, GlmExtractorService],
      useFactory: (
        config: ConfigService,
        qwen: QwenExtractorService,
        glm: GlmExtractorService,
      ): InvoiceExtractor => {
        const provider = (
          config.get<string>('INVOICE_AI_PROVIDER') ?? 'qwen'
        ).trim().toLowerCase();
        const chosen = provider === 'glm' ? glm : qwen;
        const logger = new Logger('InvoiceScanModule');
        if (!chosen.enabled) {
          logger.warn(
            `Lectura de facturas sin configurar (proveedor "${provider}"): subir una factura responderá 503.`,
          );
        } else {
          logger.log(`Lectura de facturas con ${chosen.model}`);
        }
        return chosen;
      },
    },
  ],
  exports: [InvoiceScanService],
})
export class InvoiceScanModule {}
