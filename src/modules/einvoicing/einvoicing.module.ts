import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
} from './infrastructure/schemas/electronic-document.schema';
import {
  EinvoicingAccount,
  EinvoicingAccountSchema,
} from './infrastructure/schemas/einvoicing-account.schema';
import {
  Counter,
  CounterSchema,
} from '../sales/infrastructure/schemas/counter.schema';
import { EinvoicingService } from './application/einvoicing.service';
import { EinvoicingAccountsService } from './application/einvoicing-accounts.service';
import { EinvoicingRetryScheduler } from './application/einvoicing-retry.scheduler';
import {
  EINVOICE_PROVIDER,
  EinvoiceProvider,
} from './application/einvoice-provider';
import { ApidianClient } from './infrastructure/apidian.client';
import { FakeEinvoiceProvider } from './infrastructure/fake-einvoice.provider';
import { EinvoicingController } from './infrastructure/einvoicing.controller';
import { SalesModule } from '../sales/sales.module';
import { SedesModule } from '../sedes/sedes.module';
import { ControlModule } from '../control/control.module';

/**
 * Facturación electrónica ante la DIAN.
 *
 * Quién firma y transmite lo decide `EINVOICING_PROVIDER` al arrancar:
 * - `apidian`: APIDIAN en servidor propio (`APIDIAN_URL`). Lo de producción.
 * - `simulado`: acepta todo sin salir a la red. Para desarrollo y demos.
 * Sin la variable, se usa APIDIAN si hay `APIDIAN_URL` y el simulado si no.
 *
 * Se resuelve por fábrica, como el lector de facturas de compra, para que el
 * resto del código no sepa nunca con quién está hablando.
 */
@Module({
  imports: [
    TenantMongooseModule.forFeature([
      { name: ElectronicDocument.name, schema: ElectronicDocumentSchema },
      { name: EinvoicingAccount.name, schema: EinvoicingAccountSchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
    SalesModule,
    SedesModule,
    ControlModule,
  ],
  controllers: [EinvoicingController],
  providers: [
    EinvoicingService,
    EinvoicingAccountsService,
    EinvoicingRetryScheduler,
    ApidianClient,
    FakeEinvoiceProvider,
    {
      provide: EINVOICE_PROVIDER,
      inject: [ConfigService, ApidianClient, FakeEinvoiceProvider],
      useFactory: (
        config: ConfigService,
        apidian: ApidianClient,
        fake: FakeEinvoiceProvider,
      ): EinvoiceProvider => {
        const logger = new Logger('EinvoicingModule');
        const wanted = (config.get<string>('EINVOICING_PROVIDER') ?? '')
          .trim()
          .toLowerCase();
        const chosen =
          wanted === 'apidian'
            ? apidian
            : wanted === 'simulado'
              ? fake
              : apidian.enabled
                ? apidian
                : fake;
        if (chosen === fake) {
          const prod = config.get<string>('NODE_ENV') === 'production';
          // En producción el simulado emitiría "facturas" sin valor ante la
          // DIAN; se deja arrancar, pero que se note.
          (prod ? logger.error.bind(logger) : logger.warn.bind(logger))(
            'Facturación electrónica en modo SIMULADO: nada se envía a la DIAN.',
          );
        } else if (!apidian.enabled) {
          logger.warn(
            'EINVOICING_PROVIDER=apidian sin APIDIAN_URL: emitir responderá con error.',
          );
        } else {
          logger.log('Facturación electrónica con APIDIAN.');
        }
        return chosen;
      },
    },
  ],
  exports: [EinvoicingService],
})
export class EinvoicingModule {}
