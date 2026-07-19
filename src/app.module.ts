import { Module, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { HealthModule } from './modules/health/health.module';
import { CoreAuthModule } from './modules/core-auth/core-auth.module';
import { SedesModule } from './modules/sedes/sedes.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      useFactory: () => {
        const uri =
          process.env.MONGODB_URI ??
          'mongodb://localhost:27017/erp?replicaSet=rs0';
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
    HealthModule,
    CoreAuthModule,
    SedesModule,
    InventoryModule,
    SuppliersModule,
  ],
})
export class AppModule {}
