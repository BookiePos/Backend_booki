import { Module } from '@nestjs/common';
import { HealthController } from './infrastructure/health.controller';

/**
 * Módulo de salud — expone GET /health para liveness/readiness.
 * Sin lógica de negocio; solo reporta estado del proceso y de la conexión Mongo.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
