import { attachDatabasePool } from '@vercel/functions';
import { POOL_MONGO, uriSinCredenciales } from './shared/config/mongo';
import { Module, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Connection } from 'mongoose';
import { TenancyModule } from './shared/tenancy/tenancy.module';
import { MongoThrottlerStorage } from './shared/throttle/mongo-throttler.storage';
import { sinLimitesParaE2e } from './shared/throttle/sin-limites-e2e';
import type { ColeccionVentanas } from './shared/throttle/contador-ventana';
import { CONTROL_CONNECTION } from './modules/control/domain/control.constants';
import { ControlModule } from './modules/control/control.module';
import { HealthModule } from './modules/health/health.module';
import { CoreAuthModule } from './modules/core-auth/core-auth.module';
import { SedesModule } from './modules/sedes/sedes.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { SalesModule } from './modules/sales/sales.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
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
import { ProductionModule } from './modules/production/production.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { InvoiceScanModule } from './modules/invoice-scan/invoice-scan.module';
import { RestaurantModule } from './modules/restaurant/restaurant.module';
import { CustomersModule } from './modules/customers/customers.module';
import { BillingModule } from './modules/billing/billing.module';
import { CronModule } from './modules/cron/cron.module';

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

/**
 * En Vercel (Fluid compute) la función se congela entre requests: sin esto, el
 * pool deja conexiones abiertas que el cluster sigue contando (ítem 2.11).
 */
function adjuntarPoolAVercel(connection: Connection, logger: Logger): void {
  if (!process.env.VERCEL) return;
  try {
    attachDatabasePool(connection.getClient());
  } catch (err) {
    logger.warn(`No se pudo adjuntar el pool de Mongo a Vercel: ${(err as Error).message}`);
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting global: 100 req/min por IP. Los endpoints sensibles de auth
    // aprietan aún más el límite con @Throttle en su controller. Esos límites
    // estrictos se cuentan en la base de control, uno solo para todas las
    // instancias de Vercel (ítem 4.3; ver MongoThrottlerStorage).
    ThrottlerModule.forRootAsync({
      inject: [getConnectionToken(CONTROL_CONNECTION)],
      useFactory: (control: Connection) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
        errorMessage: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
        // Las pruebas e2e inician sesión muchas veces seguidas desde la misma
        // IP. Nunca aplica en producción, aunque alguien deje la variable.
        skipIf: () => sinLimitesParaE2e(),
        storage: new MongoThrottlerStorage(
          () => control.collection('throttle_ventanas') as unknown as ColeccionVentanas,
        ),
      }),
    }),
    MongooseModule.forRootAsync({
      useFactory: () => {
        const uri =
          process.env.MONGODB_URI ??
          'mongodb://localhost:27017/sistema-pos?replicaSet=rs0';
        const logger = new Logger('MongooseModule');
        return {
          uri,
          ...POOL_MONGO,
          // Falla rápido en la selección de servidor.
          serverSelectionTimeoutMS: 3000,
          // Conexión perezosa: el servidor arranca aunque Mongo no esté
          // disponible; Mongoose conecta/reconecta en segundo plano y /health
          // reporta el estado real (db: disconnected/connected).
          lazyConnection: true,
          connectionFactory: (connection: Connection) => {
            adjuntarPoolAVercel(connection, logger);
            connection.on('connected', () =>
              logger.log(`Conectado a MongoDB (${uriSinCredenciales(uri)})`),
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
        ...POOL_MONGO,
        serverSelectionTimeoutMS: 3000,
        lazyConnection: true,
        connectionFactory: (connection: Connection) => {
          adjuntarPoolAVercel(connection, new Logger('MongooseControl'));
          return connection;
        },
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
    DeliveryModule,
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
    ProductionModule,
    PurchasingModule,
    InvoiceScanModule,
    RestaurantModule,
    CustomersModule,
    BillingModule,
    CronModule,
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
