import {
  Controller,
  Get,
  Headers,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../core-auth/infrastructure/decorators/public.decorator';
import { BillingScheduler } from '../../billing/application/billing.scheduler';
import { RecurringExpenseScheduler } from '../../finance/application/recurring-expense.scheduler';
import { secretoDeCronValido } from '../domain/cron-auth';

/**
 * Disparo externo de los barridos periódicos.
 *
 * En Vercel el API es una función serverless: se congela al terminar cada
 * respuesta, así que los `setInterval` de los schedulers no llegan a correr.
 * Vercel Cron (ver `vercel.json`) llama a este endpoint una vez al día —el
 * plan Hobby no permite más— y aquí se corren los mismos barridos, que ya son
 * idempotentes: llamarlo de más nunca duplica cobros ni gastos.
 *
 * Es `@Public()` porque no hay usuario; lo protege el secreto `CRON_SECRET`.
 */
@Controller('cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly billing: BillingScheduler,
    private readonly recurrentes: RecurringExpenseScheduler,
  ) {}

  @Public()
  @Get('diario')
  async diario(@Headers('authorization') authorization?: string) {
    const secreto = this.config.get<string>('CRON_SECRET');
    if (!secreto) {
      throw new ServiceUnavailableException('CRON_SECRET no está configurado en el despliegue.');
    }
    if (!secretoDeCronValido(authorization, secreto)) {
      throw new UnauthorizedException();
    }

    const inicio = Date.now();
    // En serie: los dos tocan el control-plane y no hay prisa.
    await this.billing.sweep();
    await this.recurrentes.sweep();
    const ms = Date.now() - inicio;
    this.logger.log(`Barridos diarios terminados en ${ms} ms.`);
    return { ok: true, tareas: ['cobros', 'gastos-recurrentes'], ms };
  }
}
