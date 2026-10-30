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
import { CertificadoEmisorService } from '../../einvoicing/application/certificado-emisor.service';
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
/** Plazo para empezar empresas dentro de la función (tope de 300 s en Vercel). */
const PLAZO_BARRIDOS_MS = 240_000;

@Controller('cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly billing: BillingScheduler,
    private readonly recurrentes: RecurringExpenseScheduler,
    private readonly certificados: CertificadoEmisorService,
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
    // En serie: los dos tocan el control-plane. El segundo corre aunque el
    // primero falle (sweep() nunca lanza). Los gastos recurrentes recorren
    // empresas con plazo: la función dura 300 s y se deja margen para
    // responder (ítem 2.10); lo que no alcance sale como error y pendiente.
    const cobros = await this.billing.sweep();
    const tareas: Record<string, ResultadoBarrido> = {
      cobros,
      'gastos-recurrentes': await this.recurrentes.sweep({
        hasta: inicio + PLAZO_BARRIDOS_MS,
      }),
      // Marca los certificados .p12 que vencen en 30 días o menos (Fase 3 FE).
      'certificados-fe': await this.certificados.barrerVencimientos({
        hasta: inicio + PLAZO_BARRIDOS_MS,
      }),
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
