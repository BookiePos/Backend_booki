import { Injectable, Logger } from '@nestjs/common';
import { BusinessService } from '../../control/application/business.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { recorrerEmpresas } from '../../../shared/barridos/recorrer-empresas';
import type { ResultadoBarrido } from '../../../shared/barridos/resultado-barrido';
import {
  LIMITE_RECONSULTA_POR_EMPRESA,
  cifrasVacias,
  sumarCifras,
  type CifrasReconsulta,
} from '../domain/reconsulta';
import { TransmisionDianService } from './transmision-dian.service';
import { NominaElectronicaService } from './nomina-electronica.service';
import { HabilitacionNominaService } from './habilitacion-nomina.service';
import { HabilitacionFacturaService } from './habilitacion-factura.service';

/** Plazo por defecto si quien llama no pasa `hasta` (la función dura 300 s). */
export const PRESUPUESTO_RECONSULTA_MS = 240_000;

/**
 * Reconsulta periódica de documentos electrónicos DIAN (Fase 10), disparada por
 * `GET /cron/dian-reconsulta` cada 30 min desde GitHub Actions.
 *
 * Recorre todas las empresas activas y, DENTRO de `TenantContext.run` de cada
 * una (sin él los modelos y el bucket no saben a qué base ir), reconsulta:
 * facturas/POS/notas en `sent`, la cola de contingencia (Fase 9), nómina en `sent` y los sets de habilitación de
 * nómina y de factura/POS en curso. Es el camino de «sistema»: sin usuario, con auditoría SYSTEM.
 * Un fallo en una empresa no frena a las demás; nunca se rechaza por red: lo que
 * no sale queda en `sent` y se reintenta en la siguiente corrida.
 */
@Injectable()
export class ReconsultaDianService {
  private readonly logger = new Logger(ReconsultaDianService.name);
  private corriendo = false;

  constructor(
    private readonly businesses: BusinessService,
    private readonly transmision: TransmisionDianService,
    private readonly nomina: NominaElectronicaService,
    private readonly habilitacion: HabilitacionNominaService,
    private readonly habilitacionFactura: HabilitacionFacturaService,
  ) {}

  async barrer(
    opts: { hasta?: number; limitePorEmpresa?: number; ahora?: Date } = {},
  ): Promise<ResultadoBarrido> {
    if (this.corriendo) {
      return { estado: 'omitido', detalle: 'ya hay una reconsulta DIAN en marcha' };
    }
    this.corriendo = true;
    try {
      const hasta = opts.hasta ?? Date.now() + PRESUPUESTO_RECONSULTA_MS;
      const limite = opts.limitePorEmpresa ?? LIMITE_RECONSULTA_POR_EMPRESA;
      const businesses = await this.businesses.listActive();
      let facturas = cifrasVacias();
      let nomina = cifrasVacias();
      let sets = cifrasVacias();
      const { procesadas, pendientes, fallidas } = await recorrerEmpresas(
        businesses,
        async (biz) => {
          const businessId = biz._id.toString();
          try {
            const r = await TenantContext.run(
              { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
              async () => {
                const o = { hasta, ahora: opts.ahora };
                // En serie por empresa: comparten el cupo de tiempo y la base.
                const enVuelo = await this.transmision.reconsultarPendientes(limite, o);
                // Cola de contingencia (Fase 9): 04/08 cuando la DIAN vuelve,
                // 03/07 transcritos y sus notas en orden, dentro del plazo legal.
                const f = sumarCifras(enVuelo, await this.transmision.transmitirContingencias(limite, o));
                const n = await this.nomina.reconsultarPendientes(limite, o);
                const sn = await this.habilitacion.avanzarEnCurso(limite, o);
                // Sets de habilitación de factura/POS en curso, con el mismo plazo `hasta`.
                const sf = await this.habilitacionFactura.avanzarEnCurso(limite, o);
                return { f, n, s: sumarCifras(sn, sf) };
              },
            );
            facturas = sumarCifras(facturas, r.f);
            nomina = sumarCifras(nomina, r.n);
            sets = sumarCifras(sets, r.s);
            // Un error inesperado en un documento marca la empresa como fallida
            // (el resto de sus documentos sí avanzó).
            if (r.f.errores + r.n.errores + r.s.errores > 0) {
              throw new Error('hubo documentos con error inesperado');
            }
          } catch (err) {
            this.logger.error(
              `Fallo en la reconsulta DIAN de ${businessId}: ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
          }
        },
        { hasta, clave: (biz) => biz._id.toString() },
      );
      const total: CifrasReconsulta = sumarCifras(sumarCifras(facturas, nomina), sets);
      const cifras = {
        empresas: businesses.length,
        procesadas,
        pendientes,
        fallidas: fallidas.length,
        revisados: total.revisados,
        avanzados: total.avanzados,
        omitidos: total.omitidos,
        errores: total.errores,
        facturasRevisadas: facturas.revisados,
        nominaRevisada: nomina.revisados,
        setsRevisados: sets.revisados,
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
      // El detalle crudo solo al log: la respuesta es pública de cara al workflow.
      this.logger.error(`Fallo en la reconsulta DIAN: ${err instanceof Error ? err.message : String(err)}`);
      return { estado: 'error', detalle: 'falló la reconsulta DIAN (ver el log)' };
    } finally {
      this.corriendo = false;
    }
  }
}
