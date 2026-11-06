import { Injectable, Logger } from '@nestjs/common';
import { BusinessService } from '../../control/application/business.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { ResultadoBarrido } from '../../../shared/barridos/resultado-barrido';
import { recorrerEmpresas } from '../../../shared/barridos/recorrer-empresas';
import { SaleReturnsService } from './sale-returns.service';

/** Tiempo para recorrer empresas si nadie fija un plazo (la función dura 300 s). */
const PRESUPUESTO_MS = 200_000;

/**
 * Barrido de devoluciones varadas (N2 de la revisión del PR #125).
 *
 * Una devolución que falló a mitad (stock, caja o libro) queda `en_curso`, y
 * sus cantidades ya cuentan como devueltas. La caja todavía no envía la llave
 * idempotente (Fase 6D), así que nadie la reintenta: este barrido, que corre
 * en `GET /cron/diario`, la termina.
 *
 * Gotcha multi-tenant: fuera de una request los modelos son proxies inertes,
 * así que se recorren las empresas del control-plane y se abre su contexto a
 * mano con `TenantContext.run`, como los demás barridos. Completar es
 * idempotente y respeta el turno de quien la esté procesando.
 */
@Injectable()
export class DevolucionesVaradasBarrido {
  private readonly logger = new Logger(DevolucionesVaradasBarrido.name);
  private running = false;

  constructor(
    private readonly businesses: BusinessService,
    private readonly returns: SaleReturnsService,
  ) {}

  /** Nunca lanza: el fallo se devuelve para que `/cron/diario` lo vea. */
  async barrer(opts: { hasta?: number } = {}): Promise<ResultadoBarrido> {
    if (this.running) {
      return { estado: 'omitido', detalle: 'ya hay un barrido de devoluciones en marcha' };
    }
    this.running = true;
    try {
      const empresas = await this.businesses.listActive();
      let completadas = 0;
      let sinTerminar = 0;
      const { procesadas, pendientes, fallidas } = await recorrerEmpresas(
        empresas,
        async (biz) => {
          const businessId = biz._id.toString();
          const r = await TenantContext.run(
            { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
            () => this.returns.completarVaradas(),
          );
          completadas += r.completadas;
          sinTerminar += r.fallidas;
          if (r.completadas + r.fallidas > 0) {
            this.logger.log(
              `Empresa ${businessId}: ${r.completadas} devolución(es) completada(s), ${r.fallidas} sin terminar.`,
            );
          }
        },
        { hasta: opts.hasta ?? Date.now() + PRESUPUESTO_MS, clave: (biz) => biz._id.toString() },
      );
      const cifras = {
        empresas: empresas.length,
        procesadas,
        pendientes,
        completadas,
        sinTerminar,
        fallidas: fallidas.length,
      };
      if (fallidas.length > 0 || pendientes > 0 || sinTerminar > 0) {
        const partes = [
          fallidas.length > 0 ? `falló en ${fallidas.length} empresa(s)` : '',
          pendientes > 0 ? `${pendientes} empresa(s) sin procesar por tiempo` : '',
          sinTerminar > 0 ? `${sinTerminar} devolución(es) siguen en curso` : '',
        ].filter(Boolean);
        return { estado: 'error', detalle: partes.join('; '), cifras };
      }
      return { estado: 'ok', cifras };
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo en el barrido de devoluciones varadas: ${detalle}`);
      return { estado: 'error', detalle };
    } finally {
      this.running = false;
    }
  }
}
