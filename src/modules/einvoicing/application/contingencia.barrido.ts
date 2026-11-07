import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ElectronicDocument,
  type ElectronicDocumentDocument,
} from '../infrastructure/schemas/electronic-document.schema';
import { BusinessService } from '../../control/application/business.service';
import { SalesService } from '../../sales/application/sales.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { ResultadoBarrido } from '../../../shared/barridos/resultado-barrido';
import { recorrerEmpresas } from '../../../shared/barridos/recorrer-empresas';
import {
  estadoPlazo,
  esTipoContingencia,
  PLAZO_TRANSMISION_HORAS,
  type ContingenciaDocumento,
  type FasePlazo,
} from '../domain/contingencia';

/** Tiempo para recorrer empresas si nadie fija un plazo (la función dura 300 s). */
const PRESUPUESTO_MS = 200_000;
/** Cuántos documentos se miran por empresa (los más viejos) y cuántos se citan en el log. */
const TOPE_POR_EMPRESA = 200;
const MUESTRA = 10;

export interface CifrasContingencia {
  abiertas: number;
  sinCorrer: number;
  enPlazo: number;
  porVencer: number;
  vencidas: number;
  rechazadas: number;
  /** Documento ya aceptado con notas que siguen sin aceptar: no corre plazo del documento. */
  notasPendientes: number;
  ventasSinTranscribir: number;
  ventasPorVencer: number;
  ventasVencidas: number;
}

const vacias = (): CifrasContingencia => ({
  abiertas: 0,
  sinCorrer: 0,
  enPlazo: 0,
  porVencer: 0,
  vencidas: 0,
  rechazadas: 0,
  notasPendientes: 0,
  ventasSinTranscribir: 0,
  ventasPorVencer: 0,
  ventasVencidas: 0,
});

/**
 * Alerta diaria de la contingencia (Fase 9, bloque 4), en `GET /cron/diario`.
 *
 * Por empresa, cuenta lo que sigue abierto frente al plazo legal de 48 h
 * (art. 37 Res. 165/2023; anexo FEV §12): documentos de contingencia sin
 * cerrar (04/08 con la DIAN aún caída, en plazo, por vencer o vencidos; los
 * rechazados) y ventas sin conexión que siguen sin transcribir (su plazo corre
 * desde que llegaron). Deja ERROR en el log con los números para que alguien
 * actúe. No transmite nada: eso es de la reconsulta (cada 30 min).
 *
 * Como `NotasColgadasBarrido`, no pone el cron en rojo por lo que encuentra
 * (solo por fallar al recorrer): va en `detalle` y en `cifras`.
 *
 * Multi-tenant: cada empresa se lee dentro de su `TenantContext.run`.
 */
@Injectable()
export class ContingenciaBarrido {
  private readonly logger = new Logger(ContingenciaBarrido.name);
  private running = false;

  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    private readonly businesses: BusinessService,
    private readonly sales: SalesService,
  ) {}

  /** Nunca lanza: el fallo se devuelve para que `/cron/diario` lo vea. */
  async barrer(opts: { hasta?: number; ahora?: Date } = {}): Promise<ResultadoBarrido> {
    if (this.running) {
      return { estado: 'omitido', detalle: 'ya hay un barrido de contingencia en marcha' };
    }
    this.running = true;
    try {
      const ahora = opts.ahora ?? new Date();
      const empresas = await this.businesses.listActive();
      const total = vacias();
      let conAlerta = 0;
      const { procesadas, pendientes, fallidas } = await recorrerEmpresas(
        empresas,
        async (biz) => {
          const businessId = biz._id.toString();
          await TenantContext.run(
            { businessId, dbName: biz.dbName, tipoNegocio: biz.tipoNegocio },
            async () => {
              const c = await this.revisarEmpresa(businessId, ahora);
              for (const k of Object.keys(total) as (keyof CifrasContingencia)[]) total[k] += c[k];
              if (c.porVencer + c.vencidas + c.rechazadas + c.ventasPorVencer + c.ventasVencidas > 0) conAlerta++;
              if (c.notasPendientes > 0) {
                this.logger.warn(`Contingencia: empresa ${businessId} tiene ${c.notasPendientes} documento(s) aceptado(s) con notas pendientes.`);
              }
            },
          );
        },
        { hasta: opts.hasta ?? Date.now() + PRESUPUESTO_MS, clave: (biz) => biz._id.toString() },
      );
      const cifras = { empresas: empresas.length, procesadas, pendientes, fallidas: fallidas.length, ...total };
      if (fallidas.length > 0 || pendientes > 0) {
        const partes = [
          fallidas.length > 0 ? `falló en ${fallidas.length} empresa(s)` : '',
          pendientes > 0 ? `${pendientes} empresa(s) sin revisar por tiempo` : '',
        ].filter(Boolean);
        return { estado: 'error', detalle: partes.join('; '), cifras };
      }
      const urgentes = total.porVencer + total.vencidas + total.ventasPorVencer + total.ventasVencidas;
      return conAlerta > 0
        ? {
            estado: 'ok',
            detalle: `alerta: ${urgentes} documento(s) o venta(s) de contingencia por vencer o vencidos y ${total.rechazadas} rechazado(s) en ${conAlerta} empresa(s)`,
            cifras,
          }
        : { estado: 'ok', cifras };
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo en el barrido de contingencia: ${detalle}`);
      return { estado: 'error', detalle };
    } finally {
      this.running = false;
    }
  }

  private async revisarEmpresa(businessId: string, ahora: Date): Promise<CifrasContingencia> {
    const c = vacias();
    const abiertos = { 'contingencia.tipo': { $exists: true }, 'contingencia.cerradaAt': null };
    // El total, sin tope; la clasificación por plazo, sobre los más viejos.
    c.abiertas = await this.model.countDocuments(abiertos).exec();
    if (c.abiertas === 0) return this.revisarVentas(businessId, ahora, c);
    const docs = (await this.model
      .find(abiertos)
      .select({ fullNumber: 1, dianStatus: 1, contingencia: 1 })
      .sort({ 'contingencia.declaradaAt': 1 })
      .limit(TOPE_POR_EMPRESA)
      .lean()
      .exec()) as unknown as { fullNumber?: string; dianStatus?: string; contingencia?: ContingenciaDocumento }[];
    const urgentes: string[] = [];
    const rechazados: string[] = [];
    for (const d of docs) {
      const cont = d.contingencia;
      if (!cont || !esTipoContingencia(cont.tipo)) continue;
      // El documento ya está aceptado y solo faltan sus notas: no está vencido.
      if (d.dianStatus === 'accepted') {
        c.notasPendientes++;
        continue;
      }
      if (d.dianStatus === 'rejected') {
        c.rechazadas++;
        rechazados.push(d.fullNumber ?? '?');
        continue;
      }
      const e = estadoPlazo(cont, ahora);
      const fase: FasePlazo = e.fase;
      if (fase === 'sin_correr') c.sinCorrer++;
      else if (fase === 'en_plazo') c.enPlazo++;
      else {
        if (fase === 'por_vencer') c.porVencer++;
        else c.vencidas++;
        urgentes.push(`${d.fullNumber ?? '?'} (${cont.tipo}, ${fase === 'vencido' ? 'vencido' : `quedan ${e.horasRestantes} h`})`);
      }
    }
    if (urgentes.length > 0) {
      this.logger.error(
        `ALERTA FE: empresa ${businessId} tiene ${urgentes.length} documento(s) de contingencia por vencer o vencidos (plazo ${PLAZO_TRANSMISION_HORAS} h): ${urgentes.slice(0, MUESTRA).join(', ')}${urgentes.length > MUESTRA ? '…' : ''}`,
      );
    }
    if (rechazados.length > 0) {
      this.logger.error(
        `ALERTA FE: empresa ${businessId} tiene ${rechazados.length} documento(s) de contingencia RECHAZADOS por la DIAN (el cliente ya los recibió como válidos): ${rechazados.slice(0, MUESTRA).join(', ')}`,
      );
    }

    return this.revisarVentas(businessId, ahora, c);
  }

  /** Ventas sin conexión sin transcribir: el plazo corre desde que llegaron. */
  private async revisarVentas(businessId: string, ahora: Date, c: CifrasContingencia): Promise<CifrasContingencia> {
    const pend = await this.sales.pendientesDeContingencia(TOPE_POR_EMPRESA);
    c.ventasSinTranscribir = pend.total;
    const ventasUrgentes: string[] = [];
    for (const v of pend.ventas) {
      if (!v.createdAt) continue;
      const e = estadoPlazo({ tipo: '07', declaradaAt: v.createdAt, superadaAt: v.createdAt }, ahora);
      if (e.fase === 'por_vencer') c.ventasPorVencer++;
      else if (e.fase === 'vencido') c.ventasVencidas++;
      else continue;
      ventasUrgentes.push(`${v.saleNumber} (${e.fase === 'vencido' ? 'vencida' : `quedan ${e.horasRestantes} h`})`);
    }
    if (ventasUrgentes.length > 0) {
      this.logger.error(
        `ALERTA FE: empresa ${businessId} tiene ${ventasUrgentes.length} venta(s) sin conexión sin transcribir en contingencia, por vencer o vencidas: ${ventasUrgentes.slice(0, MUESTRA).join(', ')}${ventasUrgentes.length > MUESTRA ? '…' : ''}`,
      );
    }
    return c;
  }
}
