import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import {
  AuditLog,
  AuditLogSchema,
} from './infrastructure/schemas/audit-log.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { AuditService } from './application/audit.service';
import { AuditController } from './infrastructure/audit.controller';
import { AuditInterceptor } from './infrastructure/audit.interceptor';

/**
 * Auditoría inmutable. Registra un interceptor GLOBAL (APP_INTERCEPTOR) que
 * captura toda escritura del sistema; el controlador solo expone la consulta.
 */
@Module({
  imports: [
    CoreAuthModule,
    TenantMongooseModule.forFeature([
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  controllers: [AuditController],
  providers: [
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class CoreAuditModule {}
