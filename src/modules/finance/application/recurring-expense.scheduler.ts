import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BusinessService } from '../../control/application/business.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { FinanceService } from './finance.service';

/** Cada cuánto se revisa si hay gastos recurrentes por generar. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h
/** Espera inicial tras el arranque (deja bootstrapear la conexión). */
const STARTUP_DELAY_MS = 60 * 1000; // 1 min

/**
 * Genera los gastos recurrentes vencidos de TODAS las empresas, periódicamente.
 *
 * Gotcha multi-tenant: los modelos son proxies inertes sin contexto de empresa
 * (solo resuelven la base `biz_<id>` dentro de `TenantContext.run`). El barrido
 * corre fuera de request, así que itera las empresas del control-plane y abre su
 * contexto a mano para cada una. La generación es idempotente (índice único
 * plantilla+ocurrencia + `lastGeneratedDate`), de modo que barrer cada pocas
 * horas nunca duplica.
 *
 * Se usa `setInterval` en vez de `@nestjs/schedule` para no añadir dependencias.
 */
@Injectable()
export class RecurringExpenseScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecurringExpenseScheduler.name);
  private startupTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly businesses: BusinessService,
    private readonly finance: FinanceService,
  ) {}

  onModuleInit(): void {
    // Barrido inicial de puesta al día, luego cada SWEEP_INTERVAL_MS.
    this.startupTimer = setTimeout(() => {
      void this.sweep();
      this.interval = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
    // No bloquear la salida del proceso por estos timers.
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Recorre las empresas activas y genera lo pendiente de cada una. */
  async sweep(): Promise<void> {
    if (this.running) return; // evita solapamiento
    this.running = true;
    try {
      const businesses = await this.businesses.listActive();
      let total = 0;
      for (const biz of businesses) {
        const businessId = biz._id.toString();
        try {
          const { generated } = await TenantContext.run(
            { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
            () => this.finance.runRecurring({ onlyAuto: true }),
          );
          total += generated;
          if (generated > 0) {
            this.logger.log(
              `Empresa ${businessId}: ${generated} gasto(s) recurrente(s) generado(s).`,
            );
          }
        } catch (err) {
          this.logger.error(
            `Fallo generando gastos recurrentes de ${businessId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (total > 0) {
        this.logger.log(`Barrido recurrente: ${total} gasto(s) en total.`);
      }
    } finally {
      this.running = false;
    }
  }
}
