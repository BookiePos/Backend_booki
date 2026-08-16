import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { jwtSecret } from '../config/jwt-secrets';
import { TenantModelRegistry } from './tenant-model.registry';
import { TenantMiddleware } from './tenant.middleware';

/**
 * Infraestructura multi-empresa, global para toda la app: el registry que
 * resuelve modelos/conexiones por empresa y el middleware que abre el contexto
 * desde el JWT.
 *
 * El middleware se aplica DESDE aquí (no desde AppModule) porque aquí viven sus
 * dependencias (JwtService del JwtModule local); NestJS resuelve el middleware
 * en el módulo que lo aplica. `forRoutes('*')` lo activa en toda la API.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: jwtSecret(config),
      }),
    }),
  ],
  providers: [TenantModelRegistry, TenantMiddleware],
  exports: [TenantModelRegistry],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
