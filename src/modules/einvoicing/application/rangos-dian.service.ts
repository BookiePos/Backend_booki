import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SedesService } from '../../sedes/application/sedes.service';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { AuditService } from '../../core-audit/application/audit.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { FiscalEmittersService } from './fiscal-emitters.service';
import {
  AmbienteNoCoincideError,
  PROVEEDOR_TRANSMISOR_DIAN,
  type ProveedorTransmisorDian,
} from './transmision-dian.puertos';
import type { TipoAmbiente } from '../domain/emisor-fiscal';

export interface RangoDianVista {
  prefijo?: string;
  desde: number;
  hasta: number;
  resolucion?: string;
  fechaResolucion?: string;
  vigenciaDesde?: string;
  vigenciaHasta?: string;
  /** ¿Ya hay una resolución registrada en la sede con ese número y prefijo? */
  registrada: boolean;
}

export interface RangosDianVista {
  ok: boolean;
  /** Código de la DIAN o del adaptador (CONFIG_FALTANTE si no se pudo consultar). */
  codigo?: string;
  mensajes: string[];
  ambiente?: string;
  rangos: RangoDianVista[];
}

/**
 * «Traer rangos de la DIAN» (`GetNumberingRange`) para una sede. Usa el
 * transmisor del emisor (su .p12, con la lectura auditada); sin credenciales el
 * transmisor es un stub y la respuesta es CONFIG_FALTANTE sin salir a la red.
 * La clave técnica NUNCA viaja: se teclea al registrar la resolución.
 */
@Injectable()
export class RangosDianService {
  constructor(
    private readonly emisores: FiscalEmittersService,
    private readonly sedes: SedesService,
    @Inject(PROVEEDOR_TRANSMISOR_DIAN) private readonly transmisores: ProveedorTransmisorDian,
    private readonly audit: AuditService,
  ) {}

  async traer(sedeId: string, user: JwtUser): Promise<RangosDianVista> {
    assertSedeAccess(user, sedeId);
    try {
      const r = await this.consultar(sedeId);
      await this.auditar(sedeId, user, r.ok, r.codigo ?? (r.ok ? 'ok' : 'sin_codigo'));
      return r;
    } catch (err) {
      await this.auditar(sedeId, user, false, (err as Error)?.name ?? 'Error');
      throw err;
    }
  }

  /**
   * Clave técnica del rango que coincide con lo que se va a registrar, leída
   * de la DIAN en el servidor: nunca viaja al navegador. `undefined` si la DIAN
   * no devuelve ese rango.
   */
  async claveTecnicaDe(
    sedeId: string,
    q: { numero?: string; prefijo?: string; desde?: number; hasta?: number },
    user: JwtUser,
  ): Promise<string | undefined> {
    assertSedeAccess(user, sedeId);
    let rangos;
    try {
      ({ rangos } = await this.crudo(sedeId));
    } catch (err) {
      if (err instanceof AmbienteNoCoincideError) return undefined;
      throw err;
    }
    const r = rangos.find(
      (x) =>
        (x.resolucion ?? '') === (q.numero ?? '') &&
        (x.prefijo ?? '') === (q.prefijo ?? '') &&
        x.desde === q.desde &&
        x.hasta === q.hasta,
    );
    return r?.claveTecnica;
  }

  private async crudo(sedeId: string) {
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor) throw new BadRequestException('La sede no tiene emisor fiscal: configúralo primero.');
    const ambiente = emisor.tipoAmbiente as TipoAmbiente;
    const transmisor = await this.transmisores.para(sedeId, ambiente);
    const r = await transmisor.rangos(emisor.nitNorm);
    return { r, rangos: r.ok ? (r.rangos ?? []) : [], ambiente };
  }

  private async consultar(sedeId: string): Promise<RangosDianVista> {
    const sede = await this.sedes.findOrFail(sedeId);
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor) throw new BadRequestException('La sede no tiene emisor fiscal: configúralo primero.');
    const ambiente = emisor.tipoAmbiente as TipoAmbiente;
    let transmisor;
    try {
      transmisor = await this.transmisores.para(sedeId, ambiente);
    } catch (err) {
      if (err instanceof AmbienteNoCoincideError) {
        return { ok: false, codigo: 'CONFIG_FALTANTE', mensajes: [err.message], ambiente, rangos: [] };
      }
      throw err;
    }
    const r = await transmisor.rangos(emisor.nitNorm);
    const registradas = [
      ...(sede.resolucionFe ? [sede.resolucionFe] : []),
      ...(sede.resolucionesFe ?? []),
    ];
    const rangos: RangoDianVista[] = (r.rangos ?? []).slice(0, 100).map((x) => ({
      prefijo: x.prefijo,
      desde: x.desde,
      hasta: x.hasta,
      resolucion: x.resolucion,
      fechaResolucion: x.fechaResolucion,
      vigenciaDesde: x.vigenciaDesde,
      vigenciaHasta: x.vigenciaHasta,
      registrada: registradas.some(
        (o) =>
          (o.numero ?? '') === (x.resolucion ?? '') &&
          (o.prefijo ?? '') === (x.prefijo ?? '') &&
          o.rangoDesde === x.desde &&
          o.rangoHasta === x.hasta,
      ),
    }));
    return {
      ok: r.ok === true,
      codigo: r.codigo,
      mensajes: (r.mensajes ?? []).slice(0, 5).map((m) => String(m).slice(0, 300)),
      ambiente,
      rangos,
    };
  }

  private async auditar(sedeId: string, user: JwtUser, success: boolean, codigo: string): Promise<void> {
    await this.audit.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method: 'GET',
      path: `/einvoicing/sedes/${sedeId}/rangos-dian`,
      success,
      action: 'einvoicing.rangos.consulta',
      detail: { sedeId, codigo: String(codigo).slice(0, 60) },
    });
  }
}
