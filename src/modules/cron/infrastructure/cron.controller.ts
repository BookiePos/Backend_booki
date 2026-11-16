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
import { ReconsultaDianService } from '../../einvoicing/application/reconsulta-dian.service';
import { DevolucionesVaradasBarrido } from '../../sales/application/devoluciones-varadas.barrido';
import { NotasColgadasBarrido } from '../../einvoicing/application/notas-colgadas.barrido';
import { ContingenciaBarrido } from '../../einvoicing/application/contingencia.barrido';
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
export const PLAZO_BARRIDOS_MS = 240_000;

@Controller('cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly billing: BillingScheduler,
    private readonly recurrentes: RecurringExpenseScheduler,
    private readonly certificados: CertificadoEmisorService,
    private readonly reconsultaDian: ReconsultaDianService,
    private readonly devoluciones: DevolucionesVaradasBarrido,
    /** Alerta de notas en `draft` colgadas (Fase 6C). Al final: no mueve las pruebas. */
    private readonly notasColgadas?: NotasColgadasBarrido,
    /** Alerta de documentos y ventas de contingencia cerca del plazo legal (Fase 9). */
    private readonly contingencia?: ContingenciaBarrido,
  ) {}

  @Public()
  @Get('diario')
  async diario(@Headers('authorization') authorization?: string) {
    this.exigirSecreto(authorization, 'diario');

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
      // Termina las devoluciones que quedaron a medias hace más de 10 min (N2).
      'devoluciones-varadas': await this.devoluciones.barrer({
        hasta: inicio + PLAZO_BARRIDOS_MS,
      }),
    };
    // Después de las devoluciones (que pueden emitir su nota): alerta de las
    // notas que siguen en `draft` hace más de N min, por empresa (Fase 6C).
    if (this.notasColgadas) {
      tareas['notas-draft-colgadas'] = await this.notasColgadas.barrer({
        hasta: inicio + PLAZO_BARRIDOS_MS,
      });
    }
    // Contingencia (Fase 9): lo que sigue abierto frente al plazo de 48 h.
    if (this.contingencia) {
      tareas['contingencia-fe'] = await this.contingencia.barrer({
        hasta: inicio + PLAZO_BARRIDOS_MS,
      });
    }
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

  /**
   * Reconsulta de documentos DIAN (Fase 10). La llama un workflow de GitHub
   * Actions cada 30 min (Vercel Hobby solo permite un cron diario). Idempotente:
   * reenviar es seguro (mismo XML, bloqueo por documento), así que llamarlo de
   * más no duplica nada. 500 si algo falló, para que el workflow se marque en rojo.
   */
  @Public()
  @Get('dian-reconsulta')
  async dianReconsulta(@Headers('authorization') authorization?: string) {
    this.exigirSecreto(authorization, 'dian-reconsulta');
    const inicio = Date.now();
    const resultado = await this.reconsultaDian.barrer({ hasta: inicio + PLAZO_BARRIDOS_MS });
    const ms = Date.now() - inicio;
    if (resultado.estado === 'error') {
      this.logger.error(`Reconsulta DIAN con fallos en ${ms} ms: ${resultado.detalle ?? 'error'}`);
      throw new InternalServerErrorException({ ok: false, tareas: { 'dian-reconsulta': resultado }, ms });
    }
    this.logger.log(`Reconsulta DIAN terminada en ${ms} ms.`);
    return { ok: true, tareas: { 'dian-reconsulta': resultado }, ms };
  }

  /** Falla cerrado: sin `CRON_SECRET` configurado nada pasa. */
  private exigirSecreto(authorization: string | undefined, ruta: string): void {
    const secreto = this.config.get<string>('CRON_SECRET');
    if (!secreto) {
      // Sin detalle en la respuesta: quien llama sin autenticar no tiene por qué
      // saber qué falta en el despliegue. El motivo queda en el log.
      this.logger.error(`CRON_SECRET no está configurado: /cron/${ruta} queda cerrado.`);
      throw new ServiceUnavailableException();
    }
    if (!secretoDeCronValido(authorization, secreto)) {
      throw new UnauthorizedException();
    }
  }
}
