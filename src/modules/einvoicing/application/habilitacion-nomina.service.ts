import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PayrollHabilitacion,
  type PayrollHabilitacionDocument,
} from '../infrastructure/schemas/payroll-habilitacion.schema';
import { FiscalEmittersService } from './fiscal-emitters.service';
import {
  AmbienteNoCoincideError,
  FIRMANTE_DIAN,
  FirmaNoDisponibleError,
  PROVEEDOR_TRANSMISOR_NOMINA,
  type FirmanteDian,
  type ProveedorTransmisorDian,
} from './transmision-dian.puertos';
import { PRESUPUESTO_RED_MAX_MS, PRESUPUESTO_RED_MIN_MS } from './transmision-dian.service';
import { decidirAmbiente } from '../domain/gate-ambiente';
import { estadoTrasRespuesta } from '../domain/estado-dian';
import { StubDian } from '../domain/stub-dian';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { ErrorFirma } from '../infrastructure/firma/material-p12';
import { empleadorDeEmisor, relojColombia } from '../domain/nomina/empleador';
import { TipoNota, type ContextoNomina, type EmisionNe, type ResultadoNomina } from '../domain/nomina/modelo';
import { armarNominaAjuste, armarNominaIndividual } from '../domain/nomina/xml-nomina';
import {
  PREFIJO_SET_NE,
  SET_NOMINA_EXIGIDO,
  UMBRAL_REENVIO_MS,
  documentoSintetico,
  mensajeAvance,
  planSetNomina,
  predecesorDeNota,
  reintentarRechazados,
  resumenSetNomina,
  type DocSetNe,
  type SetHabilitacionNe,
} from '../domain/nomina/set-habilitacion';
import { DocumentoUblInvalidoError } from '../domain/ubl/xml-ubl';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { AuditService } from '../../core-audit/application/audit.service';
import {
  MARGEN_PLAZO_RECONSULTA_MS,
  cifrasVacias,
  esRechazoDeRegla,
  type CifrasReconsulta,
} from '../domain/reconsulta';

/** Tope de una corrida: cabe holgado en la función de Vercel. */
export const PRESUPUESTO_CORRIDA_MS = 45_000;
const BLOQUEO_CORRIDA_MS = 60_000;
const MAX_MENSAJE = 300;

export interface VistaHabilitacionNomina {
  estado: 'sin_iniciar' | 'en_curso' | 'aprobada';
  aprobada: boolean;
  mensaje: string;
  testSetId?: string;
  resumen?: ReturnType<typeof resumenSetNomina>;
  documentos: {
    tipo: DocSetNe['tipo'];
    numero: string;
    estado: DocSetNe['estado'];
    mensaje: string | null;
    intentos: number;
  }[];
  /** Algo que el dueño debe corregir (certificado, TestSetId…). */
  error?: string;
}

/**
 * Habilitación automática de la nómina electrónica: arma el set de pruebas
 * con un TRABAJADOR SINTÉTICO (nunca toca empleados ni `payroll_e_documents`),
 * lo firma y lo envía con `SendTestSetAsync` (TestSetId de nómina), y
 * reconsulta el veredicto (GetStatusZip / CUNE). Solo en ambiente 2.
 * Continuable: cada llamada retoma donde quedó el set, dentro de un
 * presupuesto de tiempo, y un bloqueo por emisor evita envíos dobles.
 */
@Injectable()
export class HabilitacionNominaService {
  private readonly logger = new Logger(HabilitacionNominaService.name);

  constructor(
    @InjectModel(PayrollHabilitacion.name)
    private readonly model: Model<PayrollHabilitacionDocument>,
    private readonly emisores: FiscalEmittersService,
    @Inject(FIRMANTE_DIAN) private readonly firmante: FirmanteDian,
    @Inject(PROVEEDOR_TRANSMISOR_NOMINA) private readonly transmisores: ProveedorTransmisorDian,
    private readonly audit: AuditService,
  ) {}

  /** Arma y envía lo pendiente del set (y lo crea si no existe). */
  async iniciar(sedeId: string, user: JwtUser, ahora: Date = new Date()): Promise<VistaHabilitacionNomina> {
    TenantContext.currentOrThrow();
    assertSedeAccess(user, sedeId);
    try {
      const v = await this.correr(sedeId, true, ahora);
      await this.auditar('einvoicing.nomina.habilitacion.iniciada', user, sedeId, true, v);
      return v;
    } catch (err) {
      await this.auditar('einvoicing.nomina.habilitacion.iniciada', user, sedeId, false, undefined, err);
      throw err;
    }
  }

  /** Reconsulta el veredicto de lo enviado; no envía nada nuevo. */
  async consultar(sedeId: string, user: JwtUser, ahora: Date = new Date()): Promise<VistaHabilitacionNomina> {
    TenantContext.currentOrThrow();
    assertSedeAccess(user, sedeId);
    try {
      const v = await this.correr(sedeId, false, ahora);
      await this.auditar('einvoicing.nomina.habilitacion.consultada', user, sedeId, true, v, undefined, 'GET');
      return v;
    } catch (err) {
      await this.auditar('einvoicing.nomina.habilitacion.consultada', user, sedeId, false, undefined, err, 'GET');
      throw err;
    }
  }

  /**
   * Camino de SISTEMA (cron de reconsulta): avanza con su GET los sets de
   * habilitación de nómina que siguen en curso (no aprobados). Solo consulta, no
   * envía nada nuevo: enviar el set es una acción del dueño. Exige un
   * `TenantContext` abierto; nunca lanza por un set.
   */
  async avanzarEnCurso(
    limite: number,
    opts: { ahora?: Date; hasta?: number } = {},
  ): Promise<CifrasReconsulta> {
    TenantContext.currentOrThrow();
    const ahora = opts.ahora ?? new Date();
    const cifras = cifrasVacias();
    const filas = await this.model.find({}).sort({ updatedAt: 1 }).exec();
    const enCurso = filas.filter((f) => !resumenSetNomina(f.conjunto).aprobada).slice(0, Math.max(0, limite));
    for (const fila of enCurso) {
      if (opts.hasta !== undefined && Date.now() + MARGEN_PLAZO_RECONSULTA_MS > opts.hasta) break;
      const sedeId = fila.sedeId.toString();
      cifras.revisados++;
      try {
        const antes = resumenSetNomina(fila.conjunto);
        const v = await this.correr(sedeId, false, ahora, opts.hasta);
        if (v.resumen && v.resumen.aceptados !== antes.aceptados) cifras.avanzados++;
        await this.auditar('einvoicing.nomina.habilitacion.consultada', undefined, sedeId, true, v, undefined, 'GET');
      } catch (err) {
        if (esRechazoDeRegla(err)) cifras.omitidos++;
        else {
          cifras.errores++;
          this.logger.error(
            `Reconsulta del set de nómina de la sede ${sedeId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await this.auditar('einvoicing.nomina.habilitacion.consultada', undefined, sedeId, false, undefined, err, 'GET');
      }
    }
    return cifras;
  }

  // ── Núcleo ────────────────────────────────────────────────────────────────

  private async correr(sedeId: string, enviar: boolean, ahora: Date, hasta?: number): Promise<VistaHabilitacionNomina> {
    const base = await this.preparar(sedeId);
    let fila = await this.model.findOne({ emisorId: base.emisorId }).exec();
    if (!fila) {
      if (!enviar) {
        return { estado: 'sin_iniciar', aprobada: false, mensaje: 'El set de pruebas de nómina aún no se inició.', documentos: [] };
      }
      try {
        fila = await this.model.create({
          emisorId: new Types.ObjectId(base.emisorId),
          sedeId: new Types.ObjectId(sedeId),
          conjunto: planSetNomina(base.testSetId, ahora),
        });
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
        fila = await this.model.findOne({ emisorId: base.emisorId }).exec();
        if (!fila) throw err;
      }
    }
    const bloqueo = randomUUID();
    const tomado = await this.model
      .findOneAndUpdate(
        { _id: fila._id, $or: [{ bloqueoHasta: null }, { bloqueoHasta: { $lte: new Date() } }] },
        { $set: { bloqueo, bloqueoHasta: new Date(ahora.getTime() + BLOQUEO_CORRIDA_MS) } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!tomado) throw new ConflictException('Ya hay una corrida de la habilitación en curso: espera un minuto y consulta el avance.');

    // Desde aquí manda la copia leída DESPUÉS de tomar el bloqueo: la anterior pudo quedar vieja.
    let set = tomado.conjunto;
    let error: string | undefined;
    const persistir = async (nuevo: SetHabilitacionNe): Promise<void> => {
      set = nuevo;
      await this.model.updateOne({ _id: fila!._id, bloqueo }, { $set: { conjunto: nuevo } }).exec();
    };
    try {
      if (set.testSetId !== base.testSetId) {
        // Cambió el TestSetId: el set viejo no vale para el nuevo.
        if (!enviar) error = 'El TestSetId de nómina cambió: inicia la habilitación de nuevo.';
        else await persistir(planSetNomina(base.testSetId, ahora));
      }
      if (!(set.testSetId !== base.testSetId) && !resumenSetNomina(set).aprobada) {
        const limite = Math.min(Date.now() + PRESUPUESTO_CORRIDA_MS, hasta ?? Infinity);
        await persistir(await this.consultarEnviados(set, base.transmisor, limite, ahora));
        if (enviar) {
          await persistir(reintentarRechazados(set));
          const r = await this.enviarPendientes(set, base, limite, ahora, persistir);
          set = r.set;
          error = r.error;
        }
      }
    } finally {
      // Siempre se guarda lo avanzado y se suelta el bloqueo (un envío hecho no se puede perder).
      await this.model
        .updateOne({ _id: fila._id, bloqueo }, { $set: { conjunto: set }, $unset: { bloqueo: '', bloqueoHasta: '' } })
        .exec();
    }
    return this.vista(set, error);
  }

  /** Gate (ambiente 2 + TestSetId + credenciales) y transmisor. Todo motivo es un 409 claro. */
  private async preparar(sedeId: string) {
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor) throw new ConflictException('La sede no tiene emisor fiscal.');
    const emisorId = emisor.id as string;
    const estado = await this.emisores.estadoNomina(emisorId);
    if (estado.tipoAmbiente !== '2') {
      throw new ConflictException('La habilitación de nómina solo corre en el ambiente de habilitación (2); el emisor está en producción.');
    }
    if (!estado.testSetId) {
      throw new ConflictException('Falta el TestSetId del set de pruebas de nómina: guárdalo en la configuración de nómina del emisor.');
    }
    const decision = decidirAmbiente({
      emisor: {
        tipoAmbiente: estado.tipoAmbiente,
        habilitado: estado.habilitado,
        nitNorm: emisor.nitNorm,
        faltaParaTransmitir: estado.faltaParaTransmitir,
      },
      resolucion: null,
      documento: { tipo: 'payroll', tipoAmbiente: '2', nitNorm: emisor.nitNorm, cufe: 'por-calcular' },
    });
    if (!decision.permitido) throw new ConflictException(`Falta configurar: ${decision.motivos.join('; ')}.`);
    const empleador = empleadorDeEmisor(emisor);
    if (!empleador.ok) throw new ConflictException(`Falta configurar: ${empleador.motivos.join('; ')}.`);
    const softwarePin = await this.emisores.leerSecreto(emisorId, 'nominaPin');
    if (!estado.softwareId || !softwarePin) {
      throw new ConflictException('Falta el SoftwareID y el PIN del software de nómina.');
    }
    let transmisor: TransmisorDian;
    try {
      transmisor = await this.transmisores.para(sedeId, '2');
    } catch (err) {
      if (err instanceof AmbienteNoCoincideError) throw new ConflictException(err.message);
      throw err;
    }
    if (transmisor instanceof StubDian) {
      const r = await transmisor.enviar({ tipo: 'payroll', fullNumber: '-' });
      throw new ConflictException(`Falta configurar: ${r.mensajes.join('; ')}.`);
    }
    const ctx: ContextoNomina = { tipoAmbiente: '2', softwareId: estado.softwareId, softwarePin };
    return { emisorId, testSetId: estado.testSetId, empleador: empleador.empleador, ctx, transmisor };
  }

  // ── Envío ─────────────────────────────────────────────────────────────────

  private async enviarPendientes(
    inicial: SetHabilitacionNe,
    base: Awaited<ReturnType<HabilitacionNominaService['preparar']>>,
    limite: number,
    ahora: Date,
    persistir: (s: SetHabilitacionNe) => Promise<void>,
  ): Promise<{ set: SetHabilitacionNe; error?: string }> {
    let set = inicial;
    for (let i = 0; i < set.documentos.length; i++) {
      const d = set.documentos[i]!;
      if (d.estado !== 'pendiente') continue;
      if (limite - Date.now() < PRESUPUESTO_RED_MIN_MS * 5) break;
      const pred = d.tipo === 'niae' ? predecesorDeNota(set, i) : undefined;
      if (pred === null) continue; // la nota espera a que la DIAN acepte su nómina

      let armado: ResultadoNomina;
      let xmlFirmado: string;
      const reloj = relojColombia(ahora);
      try {
        armado = this.armar(d, pred ?? undefined, base, reloj);
        xmlFirmado = await this.firmante.firmar(armado.xml, base.emisorId);
      } catch (err) {
        if (err instanceof FirmaNoDisponibleError || err instanceof ErrorFirma) return { set, error: err.message };
        if (err instanceof DocumentoUblInvalidoError || (err as Error)?.name === 'DocumentoUblInvalidoError') {
          return { set: this.poner(set, i, { ...d, mensaje: (err as Error).message.slice(0, MAX_MENSAJE) }), error: (err as Error).message };
        }
        throw err;
      }
      const prefijo = PREFIJO_SET_NE[d.tipo];
      const enviado: DocSetNe = { ...d, cune: armado.cune, fecha: reloj.fecha, intentos: d.intentos + 1 };
      // Número + CUNE + estado se graban ANTES de salir: un corte no reenvía el mismo número con otro CUNE.
      set = this.poner(set, i, { ...enviado, estado: 'enviando', enviadoAt: ahora.toISOString() });
      await persistir(set);
      const r = await this.llamar(limite, (p) =>
        base.transmisor.enviarSetPruebas({
          tipo: d.tipo === 'niae' ? 'payroll_adjustment' : 'payroll',
          fullNumber: `${prefijo}${d.numero}`,
          cufe: armado.cune,
          xmlFirmado,
          testSetId: base.testSetId,
          ...p,
        }),
      );
      if (r.origen === 'adapter' && r.codigo === 'CONFIG_FALTANTE') {
        // Nada salió a la red: el documento sigue pendiente y se corrige la configuración.
        return { set, error: r.mensajes.join('; ').slice(0, MAX_MENSAJE) };
      }
      const trackId = r.trackId ?? r.zipKey ?? null;
      const destino = this.destino(r);
      if (trackId || destino === 'sent') {
        // En vuelo: con trackId se consulta por él; sin respuesta, por su CUNE. Nunca se reenvía.
        set = this.poner(set, i, { ...enviado, estado: 'enviado', trackId, mensaje: null, enviadoAt: ahora.toISOString() });
      } else if (destino === 'accepted') {
        set = this.poner(set, i, { ...enviado, estado: 'aceptado', mensaje: null });
      } else {
        const msg = this.texto(r);
        set = this.poner(set, i, { ...enviado, estado: 'rechazado', mensaje: msg });
        if (r.mensajes.some((m) => /testsetid|set de prueba/i.test(m))) {
          return { set, error: `La DIAN no recibió el set de pruebas de nómina: ${msg} Revisa el TestSetId de nómina.` };
        }
      }
    }
    return { set };
  }

  private armar(
    d: DocSetNe,
    pred: DocSetNe | undefined,
    base: Awaited<ReturnType<HabilitacionNominaService['preparar']>>,
    reloj: { fecha: string; hora: string },
  ): ResultadoNomina {
    const emision: EmisionNe = {
      fecha: reloj.fecha,
      hora: reloj.hora,
      prefijo: PREFIJO_SET_NE[d.tipo],
      consecutivo: d.numero,
      empleador: base.empleador,
    };
    const documento = documentoSintetico(
      { departamento: base.empleador.departamento, municipio: base.empleador.municipio, direccion: base.empleador.direccion },
      reloj.fecha,
    );
    if (d.tipo === 'niae' && pred && d.nota === 'eliminar') {
      return armarNominaAjuste(
        {
          tipoNota: TipoNota.Eliminar,
          emision,
          predecesor: { numero: `${PREFIJO_SET_NE.nie}${pred.numero}`, cune: pred.cune!, fecha: pred.fecha! },
        },
        base.ctx,
      );
    }
    if (d.tipo === 'niae' && pred) {
      return armarNominaAjuste(
        {
          tipoNota: TipoNota.Reemplazar,
          emision,
          predecesor: { numero: `${PREFIJO_SET_NE.nie}${pred.numero}`, cune: pred.cune!, fecha: pred.fecha! },
          documento,
        },
        base.ctx,
      );
    }
    return armarNominaIndividual({ emision, documento }, base.ctx);
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  private async consultarEnviados(set: SetHabilitacionNe, transmisor: TransmisorDian, limite: number, ahora: Date): Promise<SetHabilitacionNe> {
    let actual = set;
    for (let i = 0; i < actual.documentos.length; i++) {
      const d = actual.documentos[i]!;
      if (d.estado !== 'enviado' && d.estado !== 'enviando') continue;
      if (limite - Date.now() < PRESUPUESTO_RED_MIN_MS * 2) break;
      const r = await this.llamar(limite, (p) =>
        transmisor.consultar({ trackId: d.trackId ?? undefined, cufe: d.cune ?? undefined, ...p }),
      );
      const destino = this.destino(r);
      if (destino === 'accepted') actual = this.poner(actual, i, { ...d, estado: 'aceptado', mensaje: null });
      else if (destino === 'rejected') actual = this.poner(actual, i, { ...d, estado: 'rechazado', mensaje: this.texto(r) });
      else if (
        // Un envío sin trackId (timeout de SendTestSetAsync) nunca avanzaría por GetStatusZip: se trata como enviando.
        (d.estado === 'enviando' || (d.estado === 'enviado' && !d.trackId)) &&
        r.codigo === 'NO_RECIBIDO_DIAN' &&
        (!d.enviadoAt || ahora.getTime() - new Date(d.enviadoAt).getTime() > UMBRAL_REENVIO_MS)
      ) {
        // La DIAN confirma que nunca lo recibió: queda rechazado local y vuelve a la cola con número nuevo.
        actual = this.poner(actual, i, { ...d, estado: 'rechazado', mensaje: 'El envío se cortó antes de llegar a la DIAN; se reenvía con número nuevo.' });
      }
      // Sin veredicto: sigue enviado (la DIAN aún valida o no hubo red).
    }
    return actual;
  }

  // ── Utilidades ────────────────────────────────────────────────────────────

  private poner(set: SetHabilitacionNe, i: number, d: DocSetNe): SetHabilitacionNe {
    return { ...set, documentos: set.documentos.map((x, j) => (j === i ? d : x)) };
  }

  private destino(r: RespuestaDian): 'accepted' | 'rejected' | 'sent' {
    try {
      const e = estadoTrasRespuesta('sent', r);
      return e === 'accepted' || e === 'rejected' ? e : 'sent';
    } catch {
      return 'sent';
    }
  }

  private texto(r: RespuestaDian): string {
    return ((r.mensajes ?? []).join('; ') || r.codigo || 'Rechazado por la DIAN').slice(0, MAX_MENSAJE);
  }

  /** Una excepción o un timeout del adaptador es un fallo de red, nunca un veredicto. */
  private async llamar(
    limite: number,
    fn: (p: { presupuestoMs: number; signal: AbortSignal }) => Promise<RespuestaDian>,
  ): Promise<RespuestaDian> {
    const presupuestoMs = Math.min(PRESUPUESTO_RED_MAX_MS, limite - Date.now());
    const red = (m: string): RespuestaDian => ({ ok: false, codigo: 'RED', origen: 'adapter', mensajes: [m] });
    if (presupuestoMs <= 0) return red('Se agotó el tiempo de la corrida.');
    const control = new AbortController();
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const vencido = new Promise<RespuestaDian>((resolve) => {
      reloj = setTimeout(() => {
        control.abort();
        resolve(red('La DIAN no respondió dentro del presupuesto.'));
      }, presupuestoMs);
    });
    try {
      const intento = Promise.resolve().then(() => fn({ presupuestoMs, signal: control.signal }));
      intento.catch(() => undefined);
      return await Promise.race([intento, vencido]);
    } catch (err) {
      this.logger.warn(`Fallo del transmisor DIAN en la habilitación (${(err as Error)?.name ?? 'Error'}).`);
      return red('No hubo respuesta de la DIAN.');
    } finally {
      clearTimeout(reloj);
    }
  }

  private vista(set: SetHabilitacionNe, error?: string): VistaHabilitacionNomina {
    const resumen = resumenSetNomina(set);
    return {
      estado: resumen.aprobada ? 'aprobada' : 'en_curso',
      aprobada: resumen.aprobada,
      mensaje: mensajeAvance(set),
      testSetId: set.testSetId,
      resumen,
      documentos: set.documentos.map((d) => ({
        tipo: d.tipo,
        numero: `${PREFIJO_SET_NE[d.tipo]}${d.numero}`,
        estado: d.estado,
        mensaje: d.mensaje,
        intentos: d.intentos,
      })),
      ...(error ? { error } : {}),
    };
  }

  private async auditar(
    action: string,
    user: JwtUser | undefined,
    sedeId: string,
    success: boolean,
    v?: VistaHabilitacionNomina,
    err?: unknown,
    metodo: 'GET' | 'POST' = 'POST',
  ): Promise<void> {
    const detail: Record<string, string> = { sedeId: String(sedeId).slice(0, 64) };
    if (v) {
      detail.estado = v.estado;
      if (v.resumen) detail.aceptados = `${v.resumen.aceptados}/${SET_NOMINA_EXIGIDO.nie + SET_NOMINA_EXIGIDO.niae}`;
    }
    if (err) detail.error = ((err as Error)?.name ?? 'Error').slice(0, 60);
    await this.audit.record({
      userId: user?.userId,
      userEmail: user?.email,
      userName: user ? user.name : 'SYSTEM',
      role: user ? user.role : 'SYSTEM',
      method: user ? metodo : 'SERVER',
      path: `/einvoicing/sedes/${detail.sedeId}/emisor/nomina/habilitacion`,
      success,
      action,
      detail,
    });
  }
}
