import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BillingService } from './billing.service';

/** Cada cuánto se revisan renovaciones vencidas y reintentos de cobro. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h
/** Espera inicial tras el arranque (deja bootstrapear la conexión). */
const STARTUP_DELAY_MS = 90 * 1000; // 1.5 min

/**
 * Dispara el ciclo de facturación (cobro de renovaciones + dunning) de forma
 * periódica. Opera sobre el control-plane (no itera tenants). Igual que el
 * scheduler de gastos recurrentes, usa `setInterval` para no añadir
 * `@nestjs/schedule`. El cobro es idempotente por `reference`/período, así que
 * barrer de más nunca duplica cobros dentro del mismo período.
 */
@Injectable()
export class BillingScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingScheduler.name);
  private startupTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly billing: BillingService) {}

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
      const { charged, suspended } = await this.billing.runBillingCycle();
      if (charged > 0 || suspended > 0) {
        this.logger.log(
          `Ciclo de facturación: ${charged} cobro(s), ${suspended} suspensión(es).`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Fallo en el ciclo de facturación: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
