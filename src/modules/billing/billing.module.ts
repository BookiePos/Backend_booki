import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CONTROL_CONNECTION } from '../control/domain/control.constants';
import { ControlModule } from '../control/control.module';
import {
  Subscription,
  SubscriptionSchema,
} from './infrastructure/schemas/subscription.schema';
import { Payment, PaymentSchema } from './infrastructure/schemas/payment.schema';
import { WompiClient } from './infrastructure/wompi.client';
import { BillingService } from './application/billing.service';
import { BillingScheduler } from './application/billing.scheduler';
import { BillingController } from './infrastructure/billing.controller';

/**
 * Facturación/suscripciones con Wompi. Sus modelos (suscripciones y pagos)
 * viven en el control-plane (conexión `control`), junto a las empresas. Reusa
 * `BusinessService` (ControlModule) para activar/suspender planes.
 */
@Module({
  imports: [
    ControlModule,
    MongooseModule.forFeature(
      [
        { name: Subscription.name, schema: SubscriptionSchema },
        { name: Payment.name, schema: PaymentSchema },
      ],
      CONTROL_CONNECTION,
    ),
  ],
  controllers: [BillingController],
  providers: [WompiClient, BillingService, BillingScheduler],
  exports: [BillingService],
})
export class BillingModule {}
