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
      registrada: registradas.some(
        (o) => (o.numero ?? '') === (x.resolucion ?? '') && (o.prefijo ?? '') === (x.prefijo ?? ''),
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
