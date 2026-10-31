import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type UpdateQuery } from 'mongoose';
import {
  ElectronicDocument,
  type ElectronicDocumentDocument,
} from '../infrastructure/schemas/electronic-document.schema';
import type { DianStatus } from '../domain/einvoicing.constants';
import { assertTransicion, estadoTrasRespuesta } from '../domain/estado-dian';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { StubDian } from '../domain/stub-dian';
import { decidirAmbiente } from '../domain/gate-ambiente';
import { normalizarNit } from '../domain/consecutivo-unico';
import { ErrorFirma } from '../infrastructure/firma/material-p12';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { FiscalEmittersService } from './fiscal-emitters.service';
import { AuditService } from '../../core-audit/application/audit.service';
import {
  AmbienteNoCoincideError,
  ARMADOR_XML_DIAN,
  FIRMANTE_DIAN,
  FirmaNoDisponibleError,
  PROVEEDOR_TRANSMISOR_DIAN,
  type ArmadorXmlDian,
  type FirmanteDian,
  type ProveedorTransmisorDian,
} from './transmision-dian.puertos';
import { ENTREGA_DIAN, type EntregaDian } from './entrega-dian.puerto';

/**
 * Vida del bloqueo de transmisión. Mayor que la duración máxima de una función
 * en Vercel (300 s con Fluid compute): si la función muere a mitad, el bloqueo
 * vence cuando ya no puede quedar nadie trabajando con él.
 */
export const BLOQUEO_TRANSMISION_MS = 330_000;

/** Tope de cada llamada a la DIAN (enviar o consultar). */
export const PRESUPUESTO_RED_MAX_MS = 25_000;

/**
 * Presupuesto mínimo para salir a la red. Con menos no se marca `sent` ni se
 * suma el intento: la llamada no alcanzaría a terminar y el documento quedaría
 * en vuelo sin haber salido.
 */
export const PRESUPUESTO_RED_MIN_MS = 1_000;

/**
 * Margen entre el fin del presupuesto de red y el vencimiento del bloqueo: da
 * tiempo a guardar el veredicto y soltar el bloqueo antes de que otro lo tome.
 */
export const MARGEN_BLOQUEO_MS = 30_000;

/** Tope de lo que se guarda de la respuesta (los mensajes de la DIAN). */
const MAX_MENSAJES = 20;
const MAX_LARGO_MENSAJE = 500;

/** Estados desde los que se puede (re)transmitir. */
const ESTADOS_TRANSMITIBLES: readonly DianStatus[] = ['draft', 'signed', 'sent', 'rejected'];

export interface ResultadoTransmision {
  documentoId: string;
  fullNumber: string;
  dianStatus: DianStatus;
  /** ¿Esta llamada salió a la red? */
  transmitido: boolean;
  /** Código de la DIAN o del adaptador; `CONFIG_FALTANTE` si el gate lo impidió. */
  codigo?: string;
  mensajes: string[];
  intentos: number;
}

/**
 * Orquesta la transmisión de un documento electrónico a la DIAN (Fase 4B).
 *
 * El número ya se reservó al crear el documento (`EinvoicingService`): aquí
 * NUNCA se toca el contador ni el número. Un reintento reenvía el MISMO XML
 * firmado que quedó en el bucket privado; un rechazo corregido se vuelve a
 * firmar con el mismo número.
 *
 * Concurrencia: cada llamada toma un bloqueo (`bloqueoTransmision`) con un
 * `findOneAndUpdate` condicionado al estado previo; todas las escrituras de
 * estado filtran por ese estado y por el bloqueo. Una segunda llamada
 * simultánea no firma ni transmite.
 *
 * Tenancy: corre dentro del `TenantContext` de la request; los modelos y el
 * bucket resuelven la empresa desde ahí.
 */
@Injectable()
export class TransmisionDianService {
  private readonly logger = new Logger(TransmisionDianService.name);

  constructor(
    @InjectModel(ElectronicDocument.name)
    private readonly model: Model<ElectronicDocumentDocument>,
    private readonly emisores: FiscalEmittersService,
    private readonly storage: EinvoicingStorageService,
    @Inject(ARMADOR_XML_DIAN) private readonly armador: ArmadorXmlDian,
    @Inject(FIRMANTE_DIAN) private readonly firmante: FirmanteDian,
    @Inject(PROVEEDOR_TRANSMISOR_DIAN)
    private readonly transmisores: ProveedorTransmisorDian,
    private readonly audit: AuditService,
    @Optional() @Inject(ENTREGA_DIAN) private readonly entrega?: EntregaDian,
  ) {}

  /**
   * Camino HTTP: el usuario es obligatorio (acceso a la sede del documento y
   * auditoría). Un camino de sistema (cron) tendrá su propio método explícito.
   */
  async transmitir(docId: string, user: JwtUser): Promise<ResultadoTransmision> {
    // Sin empresa no hay base ni carpeta del bucket: falla antes de leer nada.
    TenantContext.currentOrThrow();
    try {
      const r = await this.ejecutar(docId, user);
      await this.auditar(docId, user, true, r.codigo ?? r.dianStatus, r);
      return r;
    } catch (err) {
      await this.auditar(docId, user, false, (err as Error)?.name ?? 'Error');
      throw err;
    }
  }

  /** Una fila por transmisión: quién, qué documento, qué intento, qué resultó. Sin secretos. */
  private async auditar(
    docId: string,
    user: JwtUser,
    success: boolean,
    codigo: string,
    r?: ResultadoTransmision,
  ): Promise<void> {
    const documentoId = String(docId).slice(0, 64);
    const detail: Record<string, string> = { documentoId, codigo: String(codigo).slice(0, 60) };
    if (r) {
      detail.fullNumber = r.fullNumber;
      detail.intento = String(r.intentos);
      detail.dianStatus = r.dianStatus;
      detail.transmitido = String(r.transmitido);
    }
    await this.audit.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method: 'POST',
      path: `/einvoicing/documentos/${documentoId}/transmitir`,
      success,
      action: 'einvoicing.documento.transmitido',
      detail,
    });
  }

  private async ejecutar(docId: string, user: JwtUser): Promise<ResultadoTransmision> {
    const doc = await this.cargar(docId);
    const sedeId = doc.sedeId.toString();
    assertSedeAccess(user, sedeId);

    if (doc.dianStatus === 'accepted') {
      return this.resultado(doc, false, undefined, ['El documento ya fue aceptado por la DIAN.']);
    }
    if (doc.dianStatus === 'contingency') {
      throw new BadRequestException(
        'El documento está en contingencia: se transmite por el flujo de contingencia.',
      );
    }
    if (!ESTADOS_TRANSMITIBLES.includes(doc.dianStatus)) {
      throw new BadRequestException(`Estado DIAN desconocido: ${String(doc.dianStatus)}`);
    }

    // ── Gate de ambiente: antes de firmar y de salir a la red ──────────────
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    const estadoEmisor = emisor
      ? await this.emisores.estadoConfiguracion(emisor.id as string)
      : null;
    const emisorDoc = doc.emisor as { nitNorm?: string; nit?: string } | undefined;
    const decision = decidirAmbiente({
      emisor: emisor
        ? {
            tipoAmbiente: emisor.tipoAmbiente,
            habilitado: emisor.habilitado,
            nitNorm: emisor.nitNorm,
            faltaParaTransmitir: estadoEmisor?.faltaParaTransmitir ?? [],
          }
        : null,
      resolucion: doc.resolution
        ? { prefijo: doc.resolution.prefijo, numero: doc.resolution.numero }
        : null,
      documento: {
        tipo: doc.type,
        tipoAmbiente: doc.tipoAmbiente,
        nitNorm: emisorDoc?.nitNorm ?? normalizarNit(emisorDoc?.nit),
        cufe: doc.cufe,
      },
    });
    if (!decision.permitido || !emisor) {
      const motivos = decision.permitido ? ['la sede no tiene emisor fiscal'] : decision.motivos;
      return this.sinRed(doc, motivos);
    }
    const emisorId = emisor.id as string;

    // El stub nunca sale a la red: si es lo que hay, ni se firma ni se marca
    // `sent` (un `sent` que nunca salió dejaría el documento en vuelo para siempre).
    let transmisor: TransmisorDian;
    try {
      transmisor = await this.transmisores.para(sedeId, decision.ambiente);
    } catch (err) {
      if (err instanceof AmbienteNoCoincideError) return this.sinRed(doc, [err.message]);
      throw err;
    }
    if (transmisor instanceof StubDian) {
      const r = await transmisor.enviar({ tipo: doc.type, fullNumber: doc.fullNumber });
      return this.sinRed(doc, r.mensajes);
    }

    const bloqueo = await this.tomarBloqueo(doc);
    if (!bloqueo) {
      const actual = await this.cargar(docId);
      return this.resultado(actual, false, 'EN_CURSO', [
        'Otra transmisión de este documento está en curso.',
      ]);
    }
    try {
      const hasta = bloqueo.doc.bloqueoHasta ?? new Date(Date.now() + BLOQUEO_TRANSMISION_MS);
      return await this.transmitirConBloqueo(bloqueo.doc, bloqueo.id, hasta, emisorId, transmisor);
    } finally {
      await this.soltarBloqueo(docId, bloqueo.id);
    }
  }

  /**
   * NO REORDENAR. El orden de los efectos es la garantía de que un documento
   * nunca se transmite sin quedar registrado ni se renumera:
   *  1. el número ya está reservado (al crear el documento);
   *  2. armar y firmar el XML (solo desde draft, rejected o signed sin XML);
   *  3. guardar el XML firmado en el bucket y el documento en `signed` con su
   *     `xmlPath`;
   *  4. marcar `sent` (+ `enviadoAt`, `intentos+1`) ANTES de llamar a la red:
   *     si la función muere durante la llamada, el documento queda en vuelo y
   *     el reintento reenvía el mismo XML en vez de volver a numerar;
   *  5. transmitir (y si la DIAN dice YA_PROCESADO, consultar por CUFE);
   *  6. aplicar el veredicto con la máquina de estados;
   *  7. si quedó `accepted`, la entrega al adquiriente (puerto `EntregaDian`),
   *     que nunca mueve el estado.
   */
  private async transmitirConBloqueo(
    inicial: ElectronicDocumentDocument,
    bloqueo: string,
    bloqueoHasta: Date,
    emisorId: string,
    transmisor: TransmisorDian,
  ): Promise<ResultadoTransmision> {
    let doc = inicial;
    const docId = String(doc._id);
    let estado = doc.dianStatus;
    let xmlFirmado: string;

    if (estado === 'draft' || estado === 'rejected' || (estado === 'signed' && !doc.xmlPath)) {
      // (2) Armar y firmar. Si el builder no existe (Fase 5) lanza aquí y el
      // documento se queda como estaba, sin consumir nada más.
      const xml = await this.armador.armar(doc);
      try {
        xmlFirmado = await this.firmante.firmar(xml, emisorId);
      } catch (err) {
        if (err instanceof FirmaNoDisponibleError || err instanceof ErrorFirma) {
          return this.sinRed(doc, [err.message], bloqueo);
        }
        throw err;
      }
      // (3) XML firmado al bucket privado y documento en `signed`.
      const { pathname } = await this.storage.guardarArtefacto(
        emisorId,
        docId,
        'xml',
        Buffer.from(xmlFirmado, 'utf8'),
      );
      if (estado !== 'signed') assertTransicion(estado, 'signed');
      doc = await this.escribirOFallar(docId, estado, bloqueo, {
        $set: { dianStatus: 'signed', xmlPath: pathname },
      });
      estado = 'signed';
    } else {
      // Reintento (signed con XML, o sent): el MISMO XML firmado, nunca se rearma.
      if (!doc.xmlPath) {
        throw new ConflictException(
          'El documento está en vuelo sin XML guardado: no se rearma ni se renumera. Revisión manual.',
        );
      }
      // La ruta guardada, no una rearmada con el emisor de hoy (la sede pudo
      // cambiar de emisor). El storage exige que esté en la carpeta de la
      // empresa del contexto y que sea el XML de ESTE documento.
      xmlFirmado = (await this.storage.leerArtefactoGuardado(doc.xmlPath, docId, 'xml')).toString('utf8');
    }

    // Sin presupuesto no se sale: ni `sent`, ni intento, ni «transmitido». El
    // documento queda donde estaba (firmado, o en vuelo si ya lo estaba).
    if (this.presupuestoRed(bloqueoHasta) < PRESUPUESTO_RED_MIN_MS) {
      this.logger.warn(`Documento ${docId}: sin presupuesto de red antes de que venza el bloqueo; no se envía.`);
      return this.resultado(doc, false, 'RED', [
        'Se agotó el tiempo de la transmisión antes de enviar; inténtalo de nuevo.',
      ]);
    }

    // (4) `sent` antes de la red.
    assertTransicion(estado, 'sent');
    doc = await this.escribirOFallar(docId, estado, bloqueo, {
      $set: { dianStatus: 'sent', enviadoAt: new Date() },
      $inc: { intentos: 1 },
    });

    // (5) Red.
    const envio = await this.llamar(bloqueoHasta, (presupuesto) =>
      transmisor.enviar({
        tipo: doc.type,
        fullNumber: doc.fullNumber,
        cufe: doc.cufe,
        xmlFirmado,
        ...presupuesto,
      }),
    );
    // ¿Salió de verdad? (casi siempre; no si el presupuesto se agotó al escribir `sent`).
    const transmitido = envio.salio;
    let r = envio.respuesta;
    if (r.codigo === 'YA_PROCESADO_DIAN') {
      // Reenvío de algo que la DIAN ya procesó: su veredicto se consulta.
      r = (
        await this.llamar(bloqueoHasta, (presupuesto) =>
          transmisor.consultar({ cufe: doc.cufe, ...presupuesto }),
        )
      ).respuesta;
    }

    // (6) Veredicto.
    const destino = this.destino(r);
    const set: Record<string, unknown> = {
      dianStatus: destino,
      respuestaDian: this.limpiar(r),
    };
    if (r.trackId) set.trackId = r.trackId;
    if (r.zipKey) set.zipKey = r.zipKey;
    if (destino === 'rejected') set.rechazoMotivo = this.motivoRechazo(r);
    const update: UpdateQuery<ElectronicDocumentDocument> = { $set: set };
    if (destino === 'accepted') update.$unset = { rechazoMotivo: '' };
    const final = await this.escribir(docId, 'sent', bloqueo, update);
    if (!final) {
      // Perdimos el bloqueo después de la red: el documento sigue en `sent`
      // y el próximo intento reenvía el mismo XML (YA_PROCESADO → consulta).
      this.logger.error(
        `Documento ${docId}: no se pudo guardar el veredicto (${destino}); queda en vuelo.`,
      );
      return this.resultado(doc, transmitido, r.codigo, r.mensajes);
    }
    // (7) Entrega al adquiriente (PDF + AttachedDocument). Después del veredicto
    // y fuera de su camino: si falla, el documento sigue aceptado.
    if (final.dianStatus === 'accepted') await this.entregarSinRomper(final);
    return this.resultado(final, transmitido, r.codigo, r.mensajes);
  }

  /** Un fallo de la entrega se registra y se reintenta luego; nunca cambia el estado DIAN. */
  private async entregarSinRomper(doc: ElectronicDocumentDocument): Promise<void> {
    if (!this.entrega) return;
    try {
      await this.entrega.entregar(doc);
    } catch (err) {
      // Solo el nombre: el mensaje podría citar el XML o rutas del bucket.
      this.logger.warn(
        `Documento ${String(doc._id)}: la entrega al adquiriente falló (${(err as Error)?.name ?? 'Error'}); se puede regenerar.`,
      );
    }
  }

  // ── Persistencia condicionada ──────────────────────────────────────────────

  private async cargar(docId: string): Promise<ElectronicDocumentDocument> {
    const doc = Types.ObjectId.isValid(docId) ? await this.model.findById(docId).exec() : null;
    if (!doc) throw new NotFoundException('Documento electrónico no encontrado');
    return doc;
  }

  /** Toma el bloqueo solo si el estado no cambió y nadie más lo tiene vigente. */
  private async tomarBloqueo(
    doc: ElectronicDocumentDocument,
  ): Promise<{ id: string; doc: ElectronicDocumentDocument } | null> {
    const id = randomUUID();
    const ahora = new Date();
    const tomado = await this.model
      .findOneAndUpdate(
        {
          _id: doc._id,
          dianStatus: doc.dianStatus,
          $or: [{ bloqueoTransmision: null }, { bloqueoHasta: { $lte: ahora } }],
        },
        {
          $set: {
            bloqueoTransmision: id,
            bloqueoHasta: new Date(ahora.getTime() + BLOQUEO_TRANSMISION_MS),
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    return tomado ? { id, doc: tomado } : null;
  }

  private async soltarBloqueo(docId: string, bloqueo: string): Promise<void> {
    try {
      await this.model
        .updateOne(
          { _id: docId, bloqueoTransmision: bloqueo },
          { $unset: { bloqueoTransmision: '', bloqueoHasta: '' } },
        )
        .exec();
    } catch (err) {
      // Si falla, el bloqueo vence solo (BLOQUEO_TRANSMISION_MS).
      this.logger.warn(`Documento ${docId}: no se pudo soltar el bloqueo (${(err as Error).name}).`);
    }
  }

  /** Escribe solo si el documento sigue en `desde` y el bloqueo es nuestro. */
  private escribir(
    docId: string,
    desde: DianStatus,
    bloqueo: string,
    update: UpdateQuery<ElectronicDocumentDocument>,
  ): Promise<ElectronicDocumentDocument | null> {
    return this.model
      .findOneAndUpdate(
        { _id: docId, dianStatus: desde, bloqueoTransmision: bloqueo },
        update,
        { returnDocument: 'after' },
      )
      .exec();
  }

  private async escribirOFallar(
    docId: string,
    desde: DianStatus,
    bloqueo: string,
    update: UpdateQuery<ElectronicDocumentDocument>,
  ): Promise<ElectronicDocumentDocument> {
    const doc = await this.escribir(docId, desde, bloqueo, update);
    if (!doc) {
      throw new ConflictException(
        'El documento cambió mientras se transmitía; no se envió. Inténtalo de nuevo.',
      );
    }
    return doc;
  }

  /**
   * Nada salió a la red: deja constancia de por qué (CONFIG_FALTANTE) sin
   * mover el estado. Con bloqueo, solo si sigue siendo nuestro; sin él, solo
   * si nadie está transmitiendo.
   */
  private async sinRed(
    doc: ElectronicDocumentDocument,
    motivos: string[],
    bloqueo?: string,
  ): Promise<ResultadoTransmision> {
    // `respuestaDian` es la última respuesta de la red: no se pisa con el
    // motivo local de no haber salido.
    const ultimoIntentoSinRed = {
      codigo: 'CONFIG_FALTANTE',
      motivos: motivos.slice(0, MAX_MENSAJES).map((m) => String(m).slice(0, MAX_LARGO_MENSAJE)),
      at: new Date(),
    };
    await this.model
      .updateOne(
        {
          _id: doc._id,
          dianStatus: doc.dianStatus,
          ...(bloqueo
            ? { bloqueoTransmision: bloqueo }
            : { $or: [{ bloqueoTransmision: null }, { bloqueoHasta: { $lte: new Date() } }] }),
        },
        { $set: { ultimoIntentoSinRed } },
      )
      .exec();
    return this.resultado(doc, false, 'CONFIG_FALTANTE', motivos);
  }

  // ── Respuesta ──────────────────────────────────────────────────────────────

  /**
   * Presupuesto de una llamada de red: nunca más que `PRESUPUESTO_RED_MAX_MS`
   * y siempre `MARGEN_BLOQUEO_MS` antes de que venza el bloqueo, para que otra
   * petición no lo tome mientras esta llamada sigue viva.
   */
  presupuestoRed(bloqueoHasta: Date, ahora: number = Date.now()): number {
    return Math.min(PRESUPUESTO_RED_MAX_MS, bloqueoHasta.getTime() - ahora - MARGEN_BLOQUEO_MS);
  }

  /**
   * Una excepción del adaptador es un fallo de red: nunca un veredicto. Sin
   * presupuesto no se llama (`salio: false`): el documento sigue en vuelo y
   * otro intento lo retoma. El tope no depende de que el transmisor lo
   * respete: la llamada compite con el temporizador (`Promise.race`) y, al
   * vencer, se aborta la señal y se responde `RED` aunque la promesa siga viva.
   */
  private async llamar(
    bloqueoHasta: Date,
    fn: (p: { presupuestoMs: number; signal: AbortSignal }) => Promise<RespuestaDian>,
  ): Promise<{ respuesta: RespuestaDian; salio: boolean }> {
    const presupuestoMs = this.presupuestoRed(bloqueoHasta);
    if (presupuestoMs <= 0) {
      this.logger.warn('Sin presupuesto de red antes de que venza el bloqueo: no se llama a la DIAN.');
      return {
        salio: false,
        respuesta: {
          ok: false,
          codigo: 'RED',
          origen: 'adapter',
          mensajes: ['Se agotó el tiempo de la transmisión; el documento queda en vuelo.'],
        },
      };
    }
    const control = new AbortController();
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const vencido = new Promise<RespuestaDian>((resolve) => {
      reloj = setTimeout(() => {
        control.abort();
        resolve({
          ok: false,
          codigo: 'RED',
          origen: 'adapter',
          mensajes: ['La DIAN no respondió dentro del presupuesto; el documento queda en vuelo.'],
        });
      }, presupuestoMs);
    });
    try {
      // `then` convierte también un throw síncrono del transmisor en rechazo.
      const intento = Promise.resolve().then(() => fn({ presupuestoMs, signal: control.signal }));
      // Si pierde la carrera, su rechazo tardío no queda sin manejar.
      intento.catch(() => undefined);
      return { salio: true, respuesta: await Promise.race([intento, vencido]) };
    } catch (err) {
      // Solo el nombre: el mensaje podría traer el XML o datos del adaptador.
      this.logger.warn(`Fallo del transmisor DIAN (${(err as Error)?.name ?? 'Error'}).`);
      return {
        salio: true,
        respuesta: {
          ok: false,
          codigo: 'RED',
          origen: 'adapter',
          mensajes: ['No hubo respuesta de la DIAN; el documento queda en vuelo.'],
        },
      };
    } finally {
      clearTimeout(reloj);
    }
  }

  /** Estado tras la respuesta. Una respuesta incoherente no mueve el documento. */
  private destino(r: RespuestaDian): DianStatus {
    try {
      return estadoTrasRespuesta('sent', r);
    } catch {
      this.logger.warn('Respuesta del transmisor DIAN fuera de contrato: el documento queda en vuelo.');
      return 'sent';
    }
  }

  /** Lo que se guarda de la respuesta: campos cerrados, mensajes acotados. */
  private limpiar(r: RespuestaDian): Record<string, unknown> {
    const mensajes = (Array.isArray(r.mensajes) ? r.mensajes : [])
      .slice(0, MAX_MENSAJES)
      .map((m) => String(m).slice(0, MAX_LARGO_MENSAJE));
    const limpia: Record<string, unknown> = {
      ok: r.ok === true,
      origen: r.origen,
      mensajes,
      recibidaAt: new Date().toISOString(),
    };
    if (typeof r.isValid === 'boolean') limpia.isValid = r.isValid;
    if (r.codigo) limpia.codigo = String(r.codigo).slice(0, 60);
    if (r.trackId) limpia.trackId = String(r.trackId).slice(0, 200);
    if (r.zipKey) limpia.zipKey = String(r.zipKey).slice(0, 200);
    if (r.cufe) limpia.cufe = String(r.cufe).slice(0, 200);
    return limpia;
  }

  private motivoRechazo(r: RespuestaDian): string {
    const texto = (r.mensajes ?? []).slice(0, MAX_MENSAJES).join('; ').slice(0, 1000);
    return texto || r.codigo || 'Rechazado por la DIAN';
  }

  private resultado(
    doc: ElectronicDocumentDocument,
    transmitido: boolean,
    codigo: string | undefined,
    mensajes: string[],
  ): ResultadoTransmision {
    return {
      documentoId: String(doc._id),
      fullNumber: doc.fullNumber,
      dianStatus: doc.dianStatus,
      transmitido,
      codigo,
      mensajes,
      intentos: doc.intentos ?? 0,
    };
  }
}
