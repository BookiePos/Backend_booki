import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BusinessService } from '../../control/application/business.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { EinvoicingService } from './einvoicing.service';

/** Cada cuánto se buscan facturas pendientes de confirmar ante la DIAN. */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // 2 min
/** Espera inicial tras el arranque (deja bootstrapear la conexión). */
const STARTUP_DELAY_MS = 60 * 1000; // 1 min

/**
 * Reintenta las facturas que quedaron pendientes porque la DIAN (o el
 * facturador) no respondió.
 *
 * La venta no se bloquea cuando la DIAN se cae: la factura queda `pending` con
 * su número y este barrido la manda cuando vuelva, con espera creciente (ver
 * `RETRY_DELAYS_MS`). Reenviar es seguro: el mismo número no entra dos veces
 * (la DIAN responde "procesado anteriormente" y se consulta el estado).
 *
 * Como el resto de barridos, usa `setInterval` en vez de `@nestjs/schedule` e
 * itera las empresas abriendo su contexto a mano.
 */
@Injectable()
export class EinvoicingRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EinvoicingRetryScheduler.name);
  private startupTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly businesses: BusinessService,
    private readonly einvoicing: EinvoicingService,
  ) {}

  onModuleInit(): void {
    this.startupTimer = setTimeout(() => {
      void this.sweep();
      this.interval = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.interval) clearInterval(this.interval);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const businesses = await this.businesses.listActive();
      for (const biz of businesses) {
        const businessId = biz._id.toString();
        try {
          const { retried, accepted } = await TenantContext.run(
            { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
            () => this.einvoicing.retryDue(),
          );
          if (retried > 0) {
            this.logger.log(
              `Empresa ${businessId}: ${retried} factura(s) reintentada(s), ${accepted} aceptada(s).`,
            );
          }
        } catch (err) {
          this.logger.error(
            `Fallo reintentando facturas de ${businessId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
