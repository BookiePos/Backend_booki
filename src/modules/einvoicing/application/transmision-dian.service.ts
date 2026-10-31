import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
import {
  ARMADOR_XML_DIAN,
  FIRMANTE_DIAN,
  FirmaNoDisponibleError,
  PROVEEDOR_TRANSMISOR_DIAN,
  type ArmadorXmlDian,
  type FirmanteDian,
  type ProveedorTransmisorDian,
} from './transmision-dian.puertos';

/**
 * Vida del bloqueo de transmisión. Mayor que el `maxDuration` de la función en
 * Vercel (60 s, `vercel.json`): si la función muere a mitad, el bloqueo vence
 * cuando ya no puede quedar nadie trabajando con él.
 */
export const BLOQUEO_TRANSMISION_MS = 120_000;

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
  ) {}

  async transmitir(docId: string, user?: JwtUser): Promise<ResultadoTransmision> {
    // Sin empresa no hay base ni carpeta del bucket: falla antes de leer nada.
    TenantContext.currentOrThrow();
    const doc = await this.cargar(docId);
    const sedeId = doc.sedeId.toString();
    if (user) assertSedeAccess(user, sedeId);

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
    const transmisor = await this.transmisores.para(sedeId, decision.ambiente);
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
      return await this.transmitirConBloqueo(bloqueo.doc, bloqueo.id, emisorId, transmisor);
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
   *  6. aplicar el veredicto con la máquina de estados.
   */
  private async transmitirConBloqueo(
    inicial: ElectronicDocumentDocument,
    bloqueo: string,
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
      xmlFirmado = (await this.storage.leerArtefacto(emisorId, docId, 'xml')).toString('utf8');
    }

    // (4) `sent` antes de la red.
    assertTransicion(estado, 'sent');
    doc = await this.escribirOFallar(docId, estado, bloqueo, {
      $set: { dianStatus: 'sent', enviadoAt: new Date() },
      $inc: { intentos: 1 },
    });

    // (5) Red.
    let r = await this.llamar(() =>
      transmisor.enviar({
        tipo: doc.type,
        fullNumber: doc.fullNumber,
        cufe: doc.cufe,
        xmlFirmado,
      }),
    );
    if (r.codigo === 'YA_PROCESADO_DIAN') {
      // Reenvío de algo que la DIAN ya procesó: su veredicto se consulta.
      r = await this.llamar(() => transmisor.consultar({ cufe: doc.cufe }));
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
      return this.resultado(doc, true, r.codigo, r.mensajes);
    }
    return this.resultado(final, true, r.codigo, r.mensajes);
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
    const r: RespuestaDian = {
      ok: false,
      codigo: 'CONFIG_FALTANTE',
      origen: 'adapter',
      mensajes: motivos,
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
        { $set: { respuestaDian: this.limpiar(r) } },
      )
      .exec();
    return this.resultado(doc, false, 'CONFIG_FALTANTE', motivos);
  }

  // ── Respuesta ──────────────────────────────────────────────────────────────

  /** Una excepción del adaptador es un fallo de red: nunca un veredicto. */
  private async llamar(fn: () => Promise<RespuestaDian>): Promise<RespuestaDian> {
    try {
      return await fn();
    } catch (err) {
      // Solo el nombre: el mensaje podría traer el XML o datos del adaptador.
      this.logger.warn(`Fallo del transmisor DIAN (${(err as Error)?.name ?? 'Error'}).`);
      return {
        ok: false,
        codigo: 'RED',
        origen: 'adapter',
        mensajes: ['No hubo respuesta de la DIAN; el documento queda en vuelo.'],
      };
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
