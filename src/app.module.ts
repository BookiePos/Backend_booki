import { Module, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Connection } from 'mongoose';
import { TenancyModule } from './shared/tenancy/tenancy.module';
import { CONTROL_CONNECTION } from './modules/control/domain/control.constants';
import { ControlModule } from './modules/control/control.module';
import { HealthModule } from './modules/health/health.module';
import { CoreAuthModule } from './modules/core-auth/core-auth.module';
import { SedesModule } from './modules/sedes/sedes.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { SalesModule } from './modules/sales/sales.module';
import { CajaModule } from './modules/caja/caja.module';
import { DiscountsModule } from './modules/discounts/discounts.module';
import { EinvoicingModule } from './modules/einvoicing/einvoicing.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { FinanceModule } from './modules/finance/finance.module';
import { CoreParamsModule } from './modules/core-params/core-params.module';
import { CoreTaxModule } from './modules/core-tax/core-tax.module';
import { CoreAuditModule } from './modules/core-audit/core-audit.module';
import { CoreLedgerModule } from './modules/core-ledger/core-ledger.module';
import { CoreReportsModule } from './modules/core-reports/core-reports.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { RestaurantModule } from './modules/restaurant/restaurant.module';
import { CustomersModule } from './modules/customers/customers.module';
import { BillingModule } from './modules/billing/billing.module';

/**
 * URI de la base de control. Por defecto reusa el mismo servidor de
 * `MONGODB_URI` cambiando el nombre de la base a `bookipos_control`. Se puede
 * fijar aparte con `CONTROL_MONGODB_URI`.
 */
function controlUri(): string {
  const explicit = process.env.CONTROL_MONGODB_URI;
  if (explicit) return explicit;
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/ert';
  // Reemplaza el nombre de base (entre el último '/' y el '?' o el final).
  return uri.replace(/\/[^/?]*(\?|$)/, '/bookipos_control$1');
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting global: 100 req/min por IP. Los endpoints sensibles de auth
    // aprietan aún más el límite con @Throttle en su controller.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    MongooseModule.forRootAsync({
      useFactory: () => {
        const uri =
          process.env.MONGODB_URI ??
          'mongodb://localhost:27017/sistema-pos?replicaSet=rs0';
        const logger = new Logger('MongooseModule');
        return {
          uri,
          // Falla rápido en la selección de servidor.
          serverSelectionTimeoutMS: 3000,
          // Conexión perezosa: el servidor arranca aunque Mongo no esté
          // disponible; Mongoose conecta/reconecta en segundo plano y /health
          // reporta el estado real (db: disconnected/connected).
          lazyConnection: true,
          connectionFactory: (connection: Connection) => {
            connection.on('connected', () =>
              logger.log(`Conectado a MongoDB (${uri})`),
            );
            connection.on('error', (err: Error) =>
              logger.error(`Error de conexión a MongoDB: ${err.message}`),
            );
            connection.on('disconnected', () =>
              logger.warn('Desconectado de MongoDB'),
            );
            return connection;
          },
        };
      },
    }),
    // Conexión al control-plane (registro de empresas): otra base en el mismo
    // Mongo. Los datos operativos de cada empresa NO viven aquí, sino en su
    // propia base `biz_<id>` a la que se apunta con useDb().
    MongooseModule.forRootAsync({
      connectionName: CONTROL_CONNECTION,
      useFactory: () => ({
        uri: controlUri(),
        serverSelectionTimeoutMS: 3000,
        lazyConnection: true,
      }),
    }),
    // Infraestructura multi-empresa (registry + middleware de contexto).
    TenancyModule,
    ControlModule,
    HealthModule,
    CoreAuthModule,
    SedesModule,
    InventoryModule,
    CatalogModule,
    SuppliersModule,
    SalesModule,
    CajaModule,
    DiscountsModule,
    EinvoicingModule,
    AttendanceModule,
    EmployeesModule,
    PayrollModule,
    FinanceModule,
    CoreParamsModule,
    CoreTaxModule,
    CoreLedgerModule,
    CoreReportsModule,
    PurchasingModule,
    RestaurantModule,
    CustomersModule,
    BillingModule,
    // La auditoría va de último: su interceptor global envuelve al resto.
    CoreAuditModule,
  ],
  providers: [
    // Rate limiting global. Se registra aquí para que corra en toda la API,
    // junto a los guards de auth/permisos que declara CoreAuthModule.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
