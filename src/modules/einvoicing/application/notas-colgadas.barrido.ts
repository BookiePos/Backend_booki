import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ElectronicDocument,
  ElectronicDocumentDocument,
} from '../infrastructure/schemas/electronic-document.schema';
import { BusinessService } from '../../control/application/business.service';
import {
  FiscalEmitter,
  FiscalEmitterDocument,
} from '../infrastructure/schemas/fiscal-emitter.schema';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { ResultadoBarrido } from '../../../shared/barridos/resultado-barrido';
import { recorrerEmpresas } from '../../../shared/barridos/recorrer-empresas';

/** Tiempo para recorrer empresas si nadie fija un plazo (la función dura 300 s). */
const PRESUPUESTO_MS = 200_000;
/** Minutos en `draft` a partir de los cuales una nota se da por colgada. */
export const NOTA_DRAFT_ALERTA_MIN_POR_DEFECTO = 60;
/** Cuántos números se citan por empresa en el log (el resto va en la cifra). */
const MUESTRA = 10;

/**
 * Alerta de notas colgadas (Fase 6C, hallazgo (a) del #125).
 *
 * La nota de una devolución, anulación o rebaja nace en `draft` y se transmite
 * detrás de la respuesta (`waitUntil`). Si esa transmisión no ocurre (función
 * congelada, DIAN caída, gate de ambiente), la nota se queda en `draft`: la
 * operación ya movió caja y libro, pero la DIAN no la conoce. Este barrido de
 * `GET /cron/diario` las cuenta por empresa y las deja en el log como ERROR,
 * con sus números, para que alguien las mire. No transmite nada: eso es de la
 * reconsulta.
 *
 * No marca el cron en rojo: una empresa sin habilitar tendría el cron en rojo
 * todos los días y taparía los fallos de verdad. Va en `detalle` y en `cifras`.
 *
 * Multi-tenant: los modelos son proxies inertes fuera de una request; cada
 * empresa se lee dentro de su `TenantContext.run`.
 */
@Injectable()
export class NotasColgadasBarrido {
  private readonly logger = new Logger(NotasColgadasBarrido.name);
  private running = false;

  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    private readonly businesses: BusinessService,
    private readonly config: ConfigService,
    @InjectModel(FiscalEmitter.name)
    private readonly emisores: Model<FiscalEmitterDocument>,
  ) {}

  /** Minutos de la alerta: `FE_NOTA_DRAFT_ALERTA_MIN` o 60. */
  minutos(): number {
    const n = Number(this.config.get<string>('FE_NOTA_DRAFT_ALERTA_MIN'));
    return Number.isInteger(n) && n > 0 ? n : NOTA_DRAFT_ALERTA_MIN_POR_DEFECTO;
  }

  /** Nunca lanza: el fallo se devuelve para que `/cron/diario` lo vea. */
  async barrer(opts: { hasta?: number; ahora?: Date } = {}): Promise<ResultadoBarrido> {
    if (this.running) {
      return { estado: 'omitido', detalle: 'ya hay un barrido de notas colgadas en marcha' };
    }
    this.running = true;
    try {
      const minutos = this.minutos();
      const limite = new Date((opts.ahora ?? new Date()).getTime() - minutos * 60_000);
      const empresas = await this.businesses.listActive();
      let colgadas = 0;
      let conColgadas = 0;
      let sinEmisor = 0;
      const { procesadas, pendientes, fallidas } = await recorrerEmpresas(
        empresas,
        async (biz) => {
          const businessId = biz._id.toString();
          await TenantContext.run(
            { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
            async () => {
              // Solo empresas que emiten (habilitadas o con el set de pruebas en
              // curso): las demás no transmiten y solo meterían ruido.
              const emite = await this.emisores
                .countDocuments({
                  $or: [{ habilitado: true }, { facturaTestSetId: { $exists: true, $nin: [null, ''] } }],
                })
                .exec();
              if (emite === 0) {
                sinEmisor += 1;
                return;
              }
              const filtro = {
                type: { $in: ['credit_note' as const, 'debit_note' as const] },
                dianStatus: 'draft' as const,
                createdAt: { $lt: limite },
              };
              const n = await this.model.countDocuments(filtro).exec();
              if (n === 0) return;
              colgadas += n;
              conColgadas += 1;
              const muestra = await this.model
                .find(filtro)
                .select({ fullNumber: 1 })
                .sort({ createdAt: 1 })
                .limit(MUESTRA)
                .lean()
                .exec();
              const numeros = muestra.map((d) => (d as { fullNumber?: string }).fullNumber ?? '?').join(', ');
              this.logger.error(
                `ALERTA FE: empresa ${businessId} tiene ${n} nota(s) en draft hace más de ${minutos} min: ${numeros}${n > MUESTRA ? '…' : ''}`,
              );
            },
          );
        },
        { hasta: opts.hasta ?? Date.now() + PRESUPUESTO_MS, clave: (biz) => biz._id.toString() },
      );
      const cifras = {
        empresas: empresas.length,
        procesadas,
        pendientes,
        fallidas: fallidas.length,
        colgadas,
        empresasConColgadas: conColgadas,
        empresasSinEmisor: sinEmisor,
        minutos,
      };
      if (fallidas.length > 0 || pendientes > 0) {
        const partes = [
          fallidas.length > 0 ? `falló en ${fallidas.length} empresa(s)` : '',
          pendientes > 0 ? `${pendientes} empresa(s) sin revisar por tiempo` : '',
        ].filter(Boolean);
        return { estado: 'error', detalle: partes.join('; '), cifras };
      }
      return colgadas > 0
        ? {
            estado: 'ok',
            detalle: `alerta: ${colgadas} nota(s) en draft hace más de ${minutos} min en ${conColgadas} empresa(s)`,
            cifras,
          }
        : { estado: 'ok', cifras };
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo en el barrido de notas colgadas: ${detalle}`);
      return { estado: 'error', detalle };
    } finally {
      this.running = false;
    }
  }
}
