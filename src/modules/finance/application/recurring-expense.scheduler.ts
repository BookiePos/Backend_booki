import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BusinessService } from '../../control/application/business.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { FinanceService } from './finance.service';
import type { ResultadoBarrido } from '../../../shared/barridos/resultado-barrido';
import { recorrerEmpresas } from '../../../shared/barridos/recorrer-empresas';

/** Tiempo para recorrer empresas si nadie fija un plazo (la función dura 300 s). */
const PRESUPUESTO_MS = 200_000;

/** Día del año (1-366): rota el punto de partida del barrido. */
function diaDelAnio(d = new Date()): number {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
}

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
    // En Vercel la función se congela entre peticiones y estos temporizadores no
    // corren: ahí el barrido lo dispara Vercel Cron vía `GET /cron/diario`.
    if (process.env.VERCEL) return;
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

  /**
   * Recorre las empresas activas y genera lo pendiente de cada una. Nunca
   * lanza (el temporizador lo llama con `void`): si alguna empresa falla, el
   * resto sigue y el fallo se devuelve para que `/cron/diario` lo vea.
   */
  /**
   * `hasta` (epoch ms): no empieza empresas nuevas después de ese momento. El
   * cron lo fija para no pasar del tope de la función (ítem 2.10).
   */
  async sweep(opts: { hasta?: number } = {}): Promise<ResultadoBarrido> {
    if (this.running) {
      return { estado: 'omitido', detalle: 'ya hay un barrido de gastos recurrentes en marcha' };
    }
    this.running = true;
    try {
      const businesses = await this.businesses.listActive();
      let total = 0;
      const { procesadas, pendientes, fallidas } = await recorrerEmpresas(
        businesses,
        async (biz) => {
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
            throw err;
          }
        },
        {
          hasta: opts.hasta ?? Date.now() + PRESUPUESTO_MS,
          // El día del año rota el punto de partida (ver recorrerEmpresas).
          desplazamiento: diaDelAnio(),
          clave: (biz) => biz._id.toString(),
        },
      );
      if (total > 0) {
        this.logger.log(`Barrido recurrente: ${total} gasto(s) en total.`);
      }
      const cifras = {
        empresas: businesses.length,
        procesadas,
        pendientes,
        generados: total,
        fallidas: fallidas.length,
      };
      if (fallidas.length > 0 || pendientes > 0) {
        const partes = [
          fallidas.length > 0 ? `falló en ${fallidas.length} empresa(s)` : '',
          pendientes > 0 ? `${pendientes} empresa(s) sin procesar por tiempo` : '',
        ].filter(Boolean);
        return { estado: 'error', detalle: partes.join('; '), cifras };
      }
      return { estado: 'ok', cifras };
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo en el barrido de gastos recurrentes: ${detalle}`);
      return { estado: 'error', detalle };
    } finally {
      this.running = false;
    }
  }
}
