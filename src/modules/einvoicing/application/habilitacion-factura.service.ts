import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  EinvoicingHabilitacion,
  type EinvoicingHabilitacionDocument,
} from '../infrastructure/schemas/einvoicing-habilitacion.schema';
import { FiscalEmittersService } from './fiscal-emitters.service';
import {
  AmbienteNoCoincideError,
  FIRMANTE_DIAN,
  FirmaNoDisponibleError,
  PROVEEDOR_TRANSMISOR_DIAN,
  type FirmanteDian,
  type ProveedorTransmisorDian,
} from './transmision-dian.puertos';
import { PRESUPUESTO_RED_MAX_MS, PRESUPUESTO_RED_MIN_MS } from './transmision-dian.service';
import { decidirAmbiente } from '../domain/gate-ambiente';
import { estadoTrasRespuesta } from '../domain/estado-dian';
import { StubDian } from '../domain/stub-dian';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { ErrorFirma } from '../infrastructure/firma/material-p12';
import { relojColombia } from '../domain/nomina/empleador';
import { armarDocumentoSet, type EmisorParaSet } from '../domain/habilitacion/documento-set';
import {
  ETIQUETA_DOC_SET,
  HABILITACION_POS_ACTIVA,
  MENSAJE_POS_DESACTIVADO,
  PREFIJO_SET,
  RESOLUCION_SETP,
  UMBRAL_REENVIO_MS,
  baseDeNota,
  mensajeAvance,
  mensajeSetAceptado,
  planSet,
  reintentarRechazados,
  resumenSet,
  type ClaseSet,
  type DocSet,
  type SetHabilitacion,
} from '../domain/habilitacion/set-habilitacion-factura';
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
export const PRESUPUESTO_CORRIDA_FACTURA_MS = 45_000;
/** Tipo de documento DIAN con el que sale cada documento del set. */
const TIPO_ENVIO = { fv: 'invoice', pos: 'pos', nc: 'credit_note', nd: 'debit_note' } as const;
const BLOQUEO_CORRIDA_MS = 60_000;
const MAX_MENSAJE = 300;

export interface VistaHabilitacionFactura {
  clase: ClaseSet;
  estado: 'sin_iniciar' | 'en_curso' | 'aprobada';
  aprobada: boolean;
  /** El set fue aceptado y el emisor quedó marcado listo para producción (el paso a ambiente 1 lo da el dueño). */
  listoParaProduccion: boolean;
  mensaje: string;
  testSetId?: string;
  resumen?: ReturnType<typeof resumenSet>;
  documentos: {
    tipo: DocSet['tipo'];
    etiqueta: string;
    numero: string;
    estado: DocSet['estado'];
    mensaje: string | null;
    intentos: number;
  }[];
  /** Algo que el dueño debe corregir (certificado, TestSetId…). */
  error?: string;
}

/**
 * Habilitación automática de la factura electrónica de venta (y, desactivada, del
 * documento equivalente POS): arma el set de pruebas con la resolución pública SETP y
 * un adquiriente de prueba (nunca toca ventas, folios, cartera, inventario ni
 * `electronic_documents`), lo firma y lo envía con `SendTestSetAsync` (TestSetId de
 * factura), y reconsulta el veredicto (GetStatusZip / CUFE). Solo en ambiente 2.
 * Continuable: cada llamada retoma donde quedó el set, dentro de un presupuesto de
 * tiempo, y un bloqueo por emisor y clase evita envíos dobles. Mismo patrón que
 * `HabilitacionNominaService`; la lógica del set viene de AlíaCorp `habilitacion.ts`.
 */
@Injectable()
export class HabilitacionFacturaService {
  private readonly logger = new Logger(HabilitacionFacturaService.name);

  constructor(
    @InjectModel(EinvoicingHabilitacion.name)
    private readonly model: Model<EinvoicingHabilitacionDocument>,
    private readonly emisores: FiscalEmittersService,
    @Inject(FIRMANTE_DIAN) private readonly firmante: FirmanteDian,
    @Inject(PROVEEDOR_TRANSMISOR_DIAN) private readonly transmisores: ProveedorTransmisorDian,
    private readonly audit: AuditService,
  ) {}

  /** Arma y envía lo pendiente del set (y lo crea si no existe). */
  async iniciar(sedeId: string, user: JwtUser, clase: ClaseSet = 'fe', ahora: Date = new Date()): Promise<VistaHabilitacionFactura> {
    TenantContext.currentOrThrow();
    assertSedeAccess(user, sedeId);
    const accion = `einvoicing.${this.nombre(clase)}.habilitacion.iniciada`;
    try {
      const v = await this.correr(sedeId, clase, true, ahora);
      await this.auditar(accion, user, sedeId, clase, true, v);
      return v;
    } catch (err) {
      await this.auditar(accion, user, sedeId, clase, false, undefined, err);
      throw err;
    }
  }

  /** Reconsulta el veredicto de lo enviado; no envía nada nuevo. */
  async consultar(sedeId: string, user: JwtUser, clase: ClaseSet = 'fe', ahora: Date = new Date()): Promise<VistaHabilitacionFactura> {
    TenantContext.currentOrThrow();
    assertSedeAccess(user, sedeId);
    const accion = `einvoicing.${this.nombre(clase)}.habilitacion.consultada`;
    try {
      const v = await this.correr(sedeId, clase, false, ahora);
      await this.auditar(accion, user, sedeId, clase, true, v, undefined, 'GET');
      return v;
    } catch (err) {
      await this.auditar(accion, user, sedeId, clase, false, undefined, err, 'GET');
      throw err;
    }
  }

  /**
   * Camino de SISTEMA (cron de reconsulta): avanza con su GET los sets de factura/POS
   * que siguen en curso. Solo consulta, no envía nada nuevo (enviar el set es una
   * acción del dueño). Exige un `TenantContext` abierto; nunca lanza por un set.
   */
  async avanzarEnCurso(limite: number, opts: { ahora?: Date; hasta?: number } = {}): Promise<CifrasReconsulta> {
    TenantContext.currentOrThrow();
    const ahora = opts.ahora ?? new Date();
    const cifras = cifrasVacias();
    const filas = await this.model.find({}).sort({ updatedAt: 1 }).exec();
    const enCurso = filas.filter((f) => !resumenSet(f.conjunto).aprobada).slice(0, Math.max(0, limite));
    for (const fila of enCurso) {
      if (opts.hasta !== undefined && Date.now() + MARGEN_PLAZO_RECONSULTA_MS > opts.hasta) break;
      const sedeId = fila.sedeId.toString();
      const clase: ClaseSet = fila.clase === 'pos' ? 'pos' : 'fe';
      const accion = `einvoicing.${this.nombre(clase)}.habilitacion.consultada`;
      cifras.revisados++;
      try {
        const antes = resumenSet(fila.conjunto);
        const v = await this.correr(sedeId, clase, false, ahora, opts.hasta);
        if (v.resumen && v.resumen.aceptados !== antes.aceptados) cifras.avanzados++;
        await this.auditar(accion, undefined, sedeId, clase, true, v, undefined, 'GET');
      } catch (err) {
        if (esRechazoDeRegla(err)) cifras.omitidos++;
        else {
          cifras.errores++;
          this.logger.error(
            `Reconsulta del set de ${this.nombre(clase)} de la sede ${sedeId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await this.auditar(accion, undefined, sedeId, clase, false, undefined, err, 'GET');
      }
    }
    return cifras;
  }

  // ── Núcleo ────────────────────────────────────────────────────────────────

  private nombre(clase: ClaseSet): string {
    return clase === 'pos' ? 'pos' : 'factura';
  }

  private async correr(
    sedeId: string,
    clase: ClaseSet,
    enviar: boolean,
    ahora: Date,
    hasta?: number,
  ): Promise<VistaHabilitacionFactura> {
    const base = await this.preparar(sedeId, clase);
    let fila = await this.model.findOne({ emisorId: base.emisorId, clase }).exec();
    if (!fila) {
      if (!enviar) {
        return {
          clase,
          estado: 'sin_iniciar',
          aprobada: false,
          listoParaProduccion: false,
          mensaje: 'El set de pruebas aún no se inició.',
          documentos: [],
        };
      }
      try {
        fila = await this.model.create({
          emisorId: new Types.ObjectId(base.emisorId),
          sedeId: new Types.ObjectId(sedeId),
          clase,
          conjunto: planSet(clase, base.testSetId, ahora),
        });
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
        fila = await this.model.findOne({ emisorId: base.emisorId, clase }).exec();
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
    if (!tomado) {
      throw new ConflictException('Ya hay una corrida de la habilitación en curso: espera un minuto y consulta el avance.');
    }

    // Desde aquí manda la copia leída DESPUÉS de tomar el bloqueo: la anterior pudo quedar vieja.
    let set = tomado.conjunto;
    let error: string | undefined;
    const persistir = async (nuevo: SetHabilitacion): Promise<void> => {
      set = nuevo;
      await this.model.updateOne({ _id: fila!._id, bloqueo }, { $set: { conjunto: nuevo } }).exec();
    };
    try {
      const cambioTestSet = set.testSetId !== base.testSetId;
      if (cambioTestSet) {
        // Cambió el TestSetId: el set viejo no vale para el nuevo.
        if (!enviar) error = 'El TestSetId de factura cambió: inicia la habilitación de nuevo.';
        else await persistir(planSet(clase, base.testSetId, ahora));
      }
      if (!(set.testSetId !== base.testSetId) && !resumenSet(set).aprobada) {
        const limite = Math.min(Date.now() + PRESUPUESTO_CORRIDA_FACTURA_MS, hasta ?? Infinity);
        await persistir(await this.consultarEnviados(set, base.transmisor, limite, ahora));
        if (enviar && !resumenSet(set).aprobada) {
          await persistir(reintentarRechazados(set));
          const r = await this.enviarPendientes(set, base, limite, ahora, persistir);
          set = r.set;
          error = r.error;
        }
      }
      // Set aceptado: el emisor queda «listo para producción» (idempotente). NO pasa solo a ambiente 1.
      // Solo con el veredicto de la DIAN sobre el SET (`aceptadoPorDian`), no por el conteo local.
      if (set.testSetId === base.testSetId && set.aceptadoPorDian === true && !set.listoMarcadoAt) {
        await this.emisores.marcarSetAprobado(base.emisorId, clase, ahora);
        set = { ...set, listoMarcadoAt: ahora.toISOString() };
      }
    } finally {
      // Siempre se guarda lo avanzado y se suelta el bloqueo (un envío hecho no se puede perder).
      await this.model
        .updateOne({ _id: fila._id, bloqueo }, { $set: { conjunto: set }, $unset: { bloqueo: '', bloqueoHasta: '' } })
        .exec();
    }
    return this.vista(set, error);
  }

  /** Gate (ambiente 2 + TestSetId + credenciales de FACTURA) y transmisor. Todo motivo es un 409 claro. */
  private async preparar(sedeId: string, clase: ClaseSet) {
    if (clase === 'pos' && !HABILITACION_POS_ACTIVA) throw new ConflictException(MENSAJE_POS_DESACTIVADO);
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor) throw new ConflictException('La sede no tiene emisor fiscal.');
    const emisorId = emisor.id as string;
    const estado = await this.emisores.estadoFactura(emisorId);
    if (estado.tipoAmbiente !== '2') {
      throw new ConflictException(
        'La habilitación solo corre en el ambiente de habilitación (2); el emisor está en producción.',
      );
    }
    if (!estado.testSetId) {
      throw new ConflictException(
        'Falta el TestSetId del set de pruebas de factura: guárdalo en la configuración de factura del emisor (PUT .../emisor/factura).',
      );
    }
    const decision = decidirAmbiente({
      emisor: {
        tipoAmbiente: estado.tipoAmbiente,
        habilitado: estado.habilitado,
        nitNorm: emisor.nitNorm,
        faltaParaTransmitir: estado.faltaParaTransmitir,
      },
      resolucion: { prefijo: RESOLUCION_SETP.prefijo, numero: RESOLUCION_SETP.numero },
      documento: {
        tipo: clase === 'pos' ? 'pos' : 'invoice',
        tipoAmbiente: '2',
        nitNorm: emisor.nitNorm,
        cufe: 'por-calcular',
      },
    });
    if (!decision.permitido) throw new ConflictException(`Falta configurar: ${decision.motivos.join('; ')}.`);
    const softwarePin = await this.emisores.leerSecreto(emisorId, 'facturaPin');
    if (!estado.softwareId || !softwarePin) {
      throw new ConflictException('Falta el SoftwareID y el PIN del software de factura.');
    }
    let transmisor: TransmisorDian;
    try {
      transmisor = await this.transmisores.para(sedeId, '2');
    } catch (err) {
      if (err instanceof AmbienteNoCoincideError) throw new ConflictException(err.message);
      throw err;
    }
    if (transmisor instanceof StubDian) {
      const r = await transmisor.enviar({ tipo: clase === 'pos' ? 'pos' : 'invoice', fullNumber: '-' });
      throw new ConflictException(`Falta configurar: ${r.mensajes.join('; ')}.`);
    }
    const datos: EmisorParaSet = {
      razonSocial: emisor.razonSocial,
      nit: emisor.nit,
      nitNorm: emisor.nitNorm,
      nitDv: emisor.nitDv,
      tipoPersona: emisor.tipoPersona,
      responsabilidadFiscal: emisor.responsabilidadFiscal,
      direccion: emisor.direccion,
      ciudad: emisor.ciudad,
      departamento: emisor.departamento,
      telefono: emisor.telefono,
      emailFacturacion: emisor.emailFacturacion,
      municipioDane: emisor.municipioDane,
      facturaSoftwareId: estado.softwareId,
      responsableIva: emisor.responsableIva,
      responsableInc: emisor.responsableInc,
      granContribuyente: emisor.granContribuyente,
      regimenRenta: emisor.regimenRenta,
    };
    return {
      emisorId,
      testSetId: estado.testSetId,
      emisor: datos,
      softwareId: estado.softwareId,
      softwarePin,
      transmisor,
    };
  }

  // ── Envío ─────────────────────────────────────────────────────────────────

  private async enviarPendientes(
    inicial: SetHabilitacion,
    base: Awaited<ReturnType<HabilitacionFacturaService['preparar']>>,
    limite: number,
    ahora: Date,
    persistir: (s: SetHabilitacion) => Promise<void>,
  ): Promise<{ set: SetHabilitacion; error?: string }> {
    let set = inicial;
    for (let i = 0; i < set.documentos.length; i++) {
      const d = set.documentos[i]!;
      if (d.estado !== 'pendiente') continue;
      if (resumenSet(set).aprobada) break; // con el set aceptado no se gasta un envío más
      if (limite - Date.now() < PRESUPUESTO_RED_MIN_MS * 5) break;

      // Una nota espera a que la DIAN acepte la factura que corrige (si la valida antes, la rechaza).
      let referencia: { numero: string; cufe: string; fecha: string } | undefined;
      if (d.tipo === 'nc' || d.tipo === 'nd') {
        const fv = baseDeNota(set);
        if (!fv) continue;
        referencia = { numero: `${PREFIJO_SET[fv.tipo]}${fv.numero}`, cufe: fv.codigo!, fecha: fv.fecha! };
      }
      const reloj = relojColombia(ahora);
      let armado: ReturnType<typeof armarDocumentoSet>;
      let xmlFirmado: string;
      try {
        armado = armarDocumentoSet({
          tipo: d.tipo,
          numero: d.numero,
          posicion: i,
          fecha: reloj.fecha,
          hora: reloj.hora,
          emisor: base.emisor,
          softwareId: base.softwareId,
          softwarePin: base.softwarePin,
          referencia,
        });
        xmlFirmado = await this.firmante.firmar(armado.xml, base.emisorId);
      } catch (err) {
        if (err instanceof FirmaNoDisponibleError || err instanceof ErrorFirma) return { set, error: err.message };
        if (err instanceof DocumentoUblInvalidoError || (err as Error)?.name === 'DocumentoUblInvalidoError') {
          const msg = (err as Error).message.slice(0, MAX_MENSAJE);
          return { set: this.poner(set, i, { ...d, mensaje: msg }), error: msg };
        }
        throw err;
      }
      const enviado: DocSet = { ...d, codigo: armado.codigo, fecha: reloj.fecha, intentos: d.intentos + 1 };
      // Número + código + estado se graban ANTES de salir: un corte no reenvía el mismo número con otro CUFE.
      set = this.poner(set, i, { ...enviado, estado: 'enviando', enviadoAt: ahora.toISOString() });
      await persistir(set);
      const r = await this.llamar(limite, (p) =>
        base.transmisor.enviarSetPruebas({
          tipo: TIPO_ENVIO[d.tipo],
          fullNumber: `${PREFIJO_SET[d.tipo]}${d.numero}`,
          cufe: armado.codigo,
          xmlFirmado,
          testSetId: base.testSetId,
          ...p,
        }),
      );
      if (r.origen === 'adapter' && r.codigo === 'CONFIG_FALTANTE') {
        // Nada salió a la red: el documento sigue pendiente y se corrige la configuración.
        return { set: this.poner(set, i, { ...d, mensaje: null }), error: r.mensajes.join('; ').slice(0, MAX_MENSAJE) };
      }
      const trackId = r.trackId ?? r.zipKey ?? null;
      const destino = this.destino(r);
      const aceptadoSet = destino === 'rejected' ? mensajeSetAceptado(r.mensajes, base.testSetId) : null;
      if (aceptadoSet) {
        set = { ...this.poner(set, i, { ...enviado, estado: 'set_aceptado', mensaje: aceptadoSet }), aceptadoPorDian: true };
      } else if (trackId || destino === 'sent') {
        // En vuelo: con trackId se consulta por él; sin respuesta, por su CUFE. Nunca se reenvía.
        set = this.poner(set, i, { ...enviado, estado: 'enviado', trackId, mensaje: null, enviadoAt: ahora.toISOString() });
      } else if (destino === 'accepted') {
        set = this.poner(set, i, { ...enviado, estado: 'aceptado', mensaje: null });
      } else {
        const msg = this.texto(r);
        set = this.poner(set, i, { ...enviado, estado: 'rechazado', mensaje: msg });
        if (r.mensajes.some((m) => /testsetid|set de prueba/i.test(m))) {
          return { set, error: `La DIAN no recibió el set de pruebas: ${msg} Revisa el TestSetId de factura.` };
        }
      }
    }
    return { set };
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  private async consultarEnviados(
    set: SetHabilitacion,
    transmisor: TransmisorDian,
    limite: number,
    ahora: Date,
  ): Promise<SetHabilitacion> {
    let actual = set;
    for (let i = 0; i < actual.documentos.length; i++) {
      const d = actual.documentos[i]!;
      if (d.estado !== 'enviado' && d.estado !== 'enviando') continue;
      if (limite - Date.now() < PRESUPUESTO_RED_MIN_MS * 2) break;
      const r = await this.llamar(limite, (p) =>
        transmisor.consultar({ trackId: d.trackId ?? undefined, cufe: d.codigo ?? undefined, ...p }),
      );
      const destino = this.destino(r);
      const aceptadoSet = destino === 'rejected' ? mensajeSetAceptado(r.mensajes, actual.testSetId) : null;
      if (aceptadoSet) {
        actual = { ...this.poner(actual, i, { ...d, estado: 'set_aceptado', mensaje: aceptadoSet }), aceptadoPorDian: true };
      } else if (destino === 'accepted') {
        actual = this.poner(actual, i, { ...d, estado: 'aceptado', mensaje: null });
        // Una aceptación que además dice «Set de prueba … Aceptado» es el veredicto del set.
        if (mensajeSetAceptado(r.mensajes, actual.testSetId)) actual = { ...actual, aceptadoPorDian: true };
      } else if (destino === 'rejected') {
        actual = this.poner(actual, i, { ...d, estado: 'rechazado', mensaje: this.texto(r) });
      } else if (
        // Un envío sin trackId (timeout de SendTestSetAsync) nunca avanzaría por GetStatusZip: se trata como enviando.
        (d.estado === 'enviando' || (d.estado === 'enviado' && !d.trackId)) &&
        r.codigo === 'NO_RECIBIDO_DIAN' &&
        (!d.enviadoAt || ahora.getTime() - new Date(d.enviadoAt).getTime() > UMBRAL_REENVIO_MS)
      ) {
        // La DIAN confirma que nunca lo recibió: queda rechazado local y vuelve a la cola con número nuevo.
        actual = this.poner(actual, i, {
          ...d,
          estado: 'rechazado',
          mensaje: 'El envío se cortó antes de llegar a la DIAN; se reenvía con número nuevo.',
        });
      }
      // Sin veredicto: sigue enviado (la DIAN aún valida o no hubo red).
    }
    return actual;
  }

  // ── Utilidades ────────────────────────────────────────────────────────────

  private poner(set: SetHabilitacion, i: number, d: DocSet): SetHabilitacion {
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

  private vista(set: SetHabilitacion, error?: string): VistaHabilitacionFactura {
    const resumen = resumenSet(set);
    return {
      clase: set.clase,
      estado: resumen.aprobada ? 'aprobada' : 'en_curso',
      aprobada: resumen.aprobada,
      listoParaProduccion: set.aceptadoPorDian === true && !!set.listoMarcadoAt,
      mensaje:
        mensajeAvance(set) +
        (set.aceptadoPorDian === true && set.clase === 'fe'
          ? ' El emisor quedó listo para producción; el paso al ambiente de producción lo da el dueño.'
          : resumen.aprobada
            ? ' Todos los documentos están aceptados, pero falta el veredicto del set de la DIAN: confirma en el portal que el software figura como habilitado antes de pasar a producción.'
            : ''),
      testSetId: set.testSetId,
      resumen,
      documentos: set.documentos.map((d) => ({
        tipo: d.tipo,
        etiqueta: ETIQUETA_DOC_SET[d.tipo],
        numero: `${PREFIJO_SET[d.tipo]}${d.numero}`,
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
    clase: ClaseSet,
    success: boolean,
    v?: VistaHabilitacionFactura,
    err?: unknown,
    metodo: 'GET' | 'POST' = 'POST',
  ): Promise<void> {
    const detail: Record<string, string> = { sedeId: String(sedeId).slice(0, 64) };
    if (v) {
      detail.estado = v.estado;
      if (v.resumen) detail.aceptados = `${v.resumen.aceptados}/${v.resumen.exigidos}`;
    }
    if (err) detail.error = ((err as Error)?.name ?? 'Error').slice(0, 60);
    await this.audit.record({
      userId: user?.userId,
      userEmail: user?.email,
      userName: user ? user.name : 'SYSTEM',
      role: user ? user.role : 'SYSTEM',
      method: user ? metodo : 'SERVER',
      path: `/einvoicing/sedes/${detail.sedeId}/emisor/${this.nombre(clase)}/habilitacion`,
      success,
      action,
      detail,
    });
  }
}
