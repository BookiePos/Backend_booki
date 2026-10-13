import {
  Controller,
  Get,
  Headers,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../core-auth/infrastructure/decorators/public.decorator';
import { BillingScheduler } from '../../billing/application/billing.scheduler';
import { RecurringExpenseScheduler } from '../../finance/application/recurring-expense.scheduler';
import { secretoDeCronValido } from '../domain/cron-auth';
import type { ResultadoBarrido } from '../../../shared/barridos/resultado-barrido';

/**
 * Disparo externo de los barridos periódicos.
 *
 * En Vercel el API es una función serverless: se congela al terminar cada
 * respuesta, así que los `setInterval` de los schedulers no llegan a correr.
 * Vercel Cron (ver `vercel.json`) llama a este endpoint una vez al día —el
 * plan Hobby no permite más— y aquí se corren los mismos barridos, que son
 * idempotentes (el cobro reserva cada intento de forma atómica): llamarlo de
 * más, incluso dos veces a la vez, nunca duplica cobros ni gastos.
 *
 * Responde 500 si algún barrido falló, para que el panel de Vercel Cron lo
 * marque en rojo en vez de enseñar un 200 que no cobró nada.
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
      // Sin detalle en la respuesta: quien llama sin autenticar no tiene por qué
      // saber qué falta en el despliegue. El motivo queda en el log.
      this.logger.error('CRON_SECRET no está configurado: /cron/diario queda cerrado.');
      throw new ServiceUnavailableException();
    }
    if (!secretoDeCronValido(authorization, secreto)) {
      throw new UnauthorizedException();
    }

    const inicio = Date.now();
    // En serie: los dos tocan el control-plane y no hay prisa. El segundo corre
    // aunque el primero falle (sweep() nunca lanza).
    const tareas: Record<string, ResultadoBarrido> = {
      cobros: await this.billing.sweep(),
      'gastos-recurrentes': await this.recurrentes.sweep(),
    };
    const ms = Date.now() - inicio;
    const fallidas = Object.entries(tareas)
      .filter(([, r]) => r.estado === 'error')
      .map(([nombre, r]) => `${nombre}: ${r.detalle ?? 'error'}`);
    if (fallidas.length > 0) {
      // 500 para que el panel de Vercel Cron marque la ejecución en rojo.
      this.logger.error(`Barridos diarios con fallos en ${ms} ms: ${fallidas.join('; ')}`);
      throw new InternalServerErrorException({ ok: false, tareas, ms });
    }
    this.logger.log(`Barridos diarios terminados en ${ms} ms.`);
    return { ok: true, tareas, ms };
  }
}
