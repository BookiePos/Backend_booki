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
  PayrollEDocument,
  type PayrollEDocumentDocument,
} from '../infrastructure/schemas/payroll-e-document.schema';
import { Counter, type CounterDocument } from '../../sales/infrastructure/schemas/counter.schema';
import type { DianStatus } from '../domain/einvoicing.constants';
import { assertTransicion, estadoTrasRespuesta } from '../domain/estado-dian';
import type { RespuestaDian, TransmisorDian } from '../domain/transmisor-dian';
import { StubDian } from '../domain/stub-dian';
import { decidirAmbiente } from '../domain/gate-ambiente';
import { normalizarNit } from '../domain/consecutivo-unico';
import { DocumentoUblInvalidoError } from '../domain/ubl/xml-ubl';
import {
  TipoNota,
  type ContextoNomina,
  type ModeloNominaAjuste,
  type ModeloNominaIndividual,
  type ResultadoNomina,
} from '../domain/nomina/modelo';
import { armarNominaAjuste, armarNominaIndividual } from '../domain/nomina/xml-nomina';
import { ErrorFirma } from '../infrastructure/firma/material-p12';
import { EinvoicingStorageService } from '../../../shared/storage/einvoicing-storage.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { AuditService } from '../../core-audit/application/audit.service';
import {
  MARGEN_PLAZO_RECONSULTA_MS,
  REPOSO_RECONSULTA_MS,
  cifrasVacias,
  esRechazoDeRegla,
  type CifrasReconsulta,
} from '../domain/reconsulta';
import { FiscalEmittersService, type EstadoNomina } from './fiscal-emitters.service';
import {
  AmbienteNoCoincideError,
  FIRMANTE_DIAN,
  FirmaNoDisponibleError,
  PROVEEDOR_TRANSMISOR_NOMINA,
  type FirmanteDian,
  type ProveedorTransmisorDian,
} from './transmision-dian.puertos';
import {
  BLOQUEO_TRANSMISION_MS,
  MARGEN_BLOQUEO_MS,
  PRESUPUESTO_RED_MAX_MS,
  PRESUPUESTO_RED_MIN_MS,
} from './transmision-dian.service';

/** Lo que el consolidador entrega ya armado: un 102 (sin `tipoNota`) o un 103. */
export type ModeloNomina = ModeloNominaIndividual | ModeloNominaAjuste;

/** Prefijos de la numeración propia de la nómina (no comparte contador con la factura). */
export const PREFIJO_NOMINA = { '102': 'NE', '103': 'NA' } as const;

/** Contador atómico por empleador y prefijo. Nunca comparte id con `fe:*`. */
export const contadorNomina = (nitNorm: string, prefijo: string): string => `nomina:${nitNorm}:${prefijo}`;

const MAX_MENSAJES = 20;
const MAX_LARGO_MENSAJE = 500;
const MAX_B64_APPLICATION_RESPONSE = 1_400_000;
const MAX_REINTENTOS_NUMERO = 3;

const esAjuste = (m: ModeloNomina): m is ModeloNominaAjuste => 'tipoNota' in m;
const esDuplicado = (err: unknown): boolean => (err as { code?: number })?.code === 11000;

export interface ResultadoNominaElectronica {
  documentoId?: string;
  fullNumber?: string;
  tipoXml?: '102' | '103';
  periodo?: string;
  dianStatus?: DianStatus;
  cune?: string;
  /** ¿Esta llamada salió a la red? */
  transmitido: boolean;
  /** Código de la DIAN o del adaptador; `CONFIG_FALTANTE` si nada salió a la red. */
  codigo?: string;
  mensajes: string[];
  intentos: number;
}

/**
 * Firma, persistencia y transmisión a la DIAN de la nómina electrónica
 * (NominaIndividual 102 / NominaIndividualDeAjuste 103).
 *
 * Misma disciplina que `TransmisionDianService` (factura): falla cerrado, solo
 * un veredicto de la DIAN (`IsValid`) acepta o rechaza, red o timeout dejan el
 * documento en vuelo (`sent`) y NUNCA se renumera: reintentar el mismo
 * documento reutiliza su número y, si ya está firmado, reenvía el mismo XML.
 * Credenciales: SIEMPRE el SoftwareID y el PIN de NÓMINA del emisor; sin ellos
 * no se calcula el CUNE ni sale nada a la red (`CONFIG_FALTANTE`).
 *
 * Tenancy: corre dentro del `TenantContext` de la request; los modelos y el
 * bucket resuelven la empresa desde ahí.
 */
@Injectable()
export class NominaElectronicaService {
  private readonly logger = new Logger(NominaElectronicaService.name);

  constructor(
    @InjectModel(PayrollEDocument.name)
    private readonly model: Model<PayrollEDocumentDocument>,
    @InjectModel(Counter.name)
    private readonly counters: Model<CounterDocument>,
    private readonly emisores: FiscalEmittersService,
    private readonly storage: EinvoicingStorageService,
    @Inject(FIRMANTE_DIAN) private readonly firmante: FirmanteDian,
    @Inject(PROVEEDOR_TRANSMISOR_NOMINA) private readonly transmisores: ProveedorTransmisorDian,
    private readonly audit: AuditService,
  ) {}

  // ── API ────────────────────────────────────────────────────────────────────

  /**
   * Arma, firma, guarda y transmite el documento de nómina de UN trabajador y
   * UN mes. Idempotente: el mismo 102 (empleador, mes, trabajador) o el mismo
   * ajuste (predecesor) no se renumera; si ya está aceptado no se vuelve a
   * enviar, y si quedó en vuelo o firmado se reenvía el mismo XML.
   *
   * `user` es el camino HTTP: si llega, SIEMPRE se comprueba el acceso a la
   * sede. Sin `user` es SOLO un camino de sistema (cron, consolidador ya
   * autorizado): no hay a quién comprobarle la sede y la auditoría queda como
   * `SERVER`. Un controlador nunca debe llamarlo sin el usuario.
   */
  async emitir(modelo: ModeloNomina, sedeId: string, user?: JwtUser): Promise<ResultadoNominaElectronica> {
    TenantContext.currentOrThrow();
    if (user) assertSedeAccess(user, sedeId);
    try {
      const r = await this.ejecutarEmision(modelo, sedeId, user);
      await this.auditar('einvoicing.nomina.emitida', user, r.documentoId ?? '-', true, r.codigo ?? r.dianStatus ?? '-', r);
      return r;
    } catch (err) {
      await this.auditar('einvoicing.nomina.emitida', user, '-', false, (err as Error)?.name ?? 'Error');
      throw err;
    }
  }

  /** Transmite (o reintenta) un documento ya generado. Reenvía el mismo XML firmado. */
  async transmitir(docId: string, user: JwtUser): Promise<ResultadoNominaElectronica> {
    TenantContext.currentOrThrow();
    try {
      const doc = await this.cargar(docId);
      assertSedeAccess(user, doc.sedeId.toString());
      const r = await this.transmitirExistente(doc);
      await this.auditar('einvoicing.nomina.transmitida', user, docId, true, r.codigo ?? r.dianStatus ?? '-', r);
      return r;
    } catch (err) {
      await this.auditar('einvoicing.nomina.transmitida', user, docId, false, (err as Error)?.name ?? 'Error');
      throw err;
    }
  }

  /**
   * Estado del documento. Si está en vuelo (`sent`) y la DIAN ya pudo
   * procesarlo, lo consulta (GetStatusZip por trackId o GetStatus por CUNE) y
   * aplica el veredicto; en cualquier otro estado no sale a la red.
   */
  async consultar(docId: string, user?: JwtUser): Promise<ResultadoNominaElectronica> {
    TenantContext.currentOrThrow();
    try {
      const doc = await this.cargar(docId);
      if (user) assertSedeAccess(user, doc.sedeId.toString());
      let r: ResultadoNominaElectronica;
      if (doc.dianStatus === 'accepted') {
        await this.repararCierre(doc);
        r = this.resultado(doc, false, undefined, []);
      } else if (doc.dianStatus !== 'sent') {
        r = this.resultado(doc, false, undefined, []);
      } else {
        const ctx = await this.contexto(doc.sedeId.toString(), {
          tipoXml: doc.tipoXml,
          tipoAmbiente: doc.tipoAmbiente,
          nitNorm: doc.emisor.nitNorm,
          cune: doc.cune,
        });
        r = ctx.ok
          ? await this.consultarVeredicto(doc, ctx.transmisor, new Date(Date.now() + BLOQUEO_TRANSMISION_MS))
          : await this.sinRed(doc, ctx.motivos);
      }
      // Toda lectura deja fila, salga o no a la red.
      await this.auditar('einvoicing.nomina.consultada', user, docId, true, r.codigo ?? r.dianStatus ?? '-', r, 'GET');
      return r;
    } catch (err) {
      await this.auditar('einvoicing.nomina.consultada', user, docId, false, (err as Error)?.name ?? 'Error', undefined, 'GET');
      throw err;
    }
  }

  /**
   * Camino de SISTEMA (cron de reconsulta): los documentos de nómina que llevan más de 10 min en
   * `sent`, de los más viejos a los más nuevos, hasta `limite`. Reenvía el MISMO
   * XML firmado (o consulta) por la misma ruta que el reintento manual, con su
   * gate de ambiente y su bloqueo. Sin usuario no hay chequeo de sede (el barrido
   * recorre todas) pero sí tenancy: exige un `TenantContext` abierto. Nunca
   * lanza por un documento: las reglas cuentan como omitidos y lo inesperado
   * como errores.
   */
  async reconsultarPendientes(
    limite: number,
    opts: { ahora?: Date; hasta?: number } = {},
  ): Promise<CifrasReconsulta> {
    TenantContext.currentOrThrow();
    const ahora = opts.ahora ?? new Date();
    const cifras = cifrasVacias();
    const docs = await this.model
      .find({
        dianStatus: 'sent',
        enviadoAt: { $lte: new Date(ahora.getTime() - REPOSO_RECONSULTA_MS) },
        $or: [{ bloqueoHasta: null }, { bloqueoHasta: { $lte: ahora } }],
      })
      .sort({ enviadoAt: 1 })
      .limit(Math.max(0, limite))
      .select('_id')
      .exec();
    for (const { _id } of docs) {
      if (opts.hasta !== undefined && Date.now() + MARGEN_PLAZO_RECONSULTA_MS > opts.hasta) break;
      const docId = String(_id);
      cifras.revisados++;
      try {
        const r = await this.transmitirExistente(await this.cargar(docId));
        if (r.dianStatus !== 'sent') cifras.avanzados++;
        await this.auditar('einvoicing.nomina.transmitida', undefined, docId, true, r.codigo ?? r.dianStatus ?? '-', r);
      } catch (err) {
        if (esRechazoDeRegla(err)) cifras.omitidos++;
        else {
          cifras.errores++;
          this.logger.error(`Reconsulta de nómina ${docId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.auditar('einvoicing.nomina.transmitida', undefined, docId, false, (err as Error)?.name ?? 'Error');
      }
    }
    return cifras;
  }

  // ── Emisión ────────────────────────────────────────────────────────────────

  private async ejecutarEmision(
    modelo: ModeloNomina,
    sedeId: string,
    user?: JwtUser,
  ): Promise<ResultadoNominaElectronica> {
    const tipoXml: '102' | '103' = esAjuste(modelo) ? '103' : '102';
    const nitModelo = normalizarNit(modelo.emision?.empleador?.nit);

    // 1. Emisor, credenciales de NÓMINA y gate: antes de reservar ningún número.
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor) return this.configFaltante(['la sede no tiene emisor fiscal']);
    if (!nitModelo || nitModelo !== emisor.nitNorm) {
      throw new BadRequestException('El NIT del empleador del modelo no coincide con el del emisor fiscal de la sede.');
    }
    const estado = await this.emisores.estadoNomina(emisor.id as string);
    const decision = this.decidir(estado, emisor.nitNorm, tipoXml, estado.tipoAmbiente, 'por-calcular');
    if (!decision.permitido) return this.configFaltante(decision.motivos);
    const ambiente = decision.ambiente;
    const softwareId = estado.softwareId;
    const softwarePin = await this.emisores.leerSecreto(emisor.id as string, 'nominaPin');
    if (!softwareId || !softwarePin) {
      return this.configFaltante(['SoftwareID y PIN del software de nómina (no se usan los de la factura)']);
    }
    const ctx: ContextoNomina = { tipoAmbiente: ambiente, softwareId, softwarePin };

    // 2. ¿Qué documento es? (idempotencia) y a quién corrige.
    const ident = await this.identificar(modelo, tipoXml, emisor.nitNorm);
    const existente = await this.model.findOne(ident.filtro).exec();
    if (existente) {
      if (existente.dianStatus === 'accepted') {
        await this.repararCierre(existente);
        return this.resultado(existente, false, undefined, ['El documento ya fue aceptado por la DIAN.']);
      }
      if (existente.xmlPath && (existente.dianStatus === 'signed' || existente.dianStatus === 'sent')) {
        // Ya firmado: el mismo XML, el mismo número.
        return this.transmitirExistente(existente);
      }
      // Borrador o rechazado: se vuelve a armar, pero su predecesor tiene que seguir siendo el último de la cadena.
      await this.verificarAjustable(ident, existente);
      return this.regenerarYTransmitir(existente, modelo, ctx, emisor.id as string);
    }

    // 3. Documento nuevo: solo se ajusta el ÚLTIMO documento aceptado y vigente de la cadena.
    await this.verificarAjustable(ident);
    return this.crearYTransmitir(modelo, tipoXml, ident, ctx, sedeId, emisor, user);
  }

  /** Llave de idempotencia y datos del trabajador/periodo (del modelo o del predecesor). */
  private async identificar(modelo: ModeloNomina, tipoXml: '102' | '103', nitNorm: string) {
    if (!esAjuste(modelo)) {
      const t = modelo.documento.trabajador;
      const docNumber = String(t.numeroDocumento).replace(/\D/g, '');
      const periodo = modelo.documento.periodo.fechaLiquidacionFin.slice(0, 7);
      if (!docNumber || !/^\d{4}-\d{2}$/.test(periodo)) {
        throw new BadRequestException('El documento del trabajador o el periodo del modelo no son válidos.');
      }
      return {
        filtro: { 'emisor.nitNorm': nitNorm, periodo, 'empleado.docNumber': docNumber, tipoXml, vigente: true },
        periodo,
        empleado: {
          docType: t.tipoDocumento,
          docNumber,
          name: [t.primerNombre, t.otrosNombres, t.primerApellido, t.segundoApellido].filter(Boolean).join(' '),
        },
        predecesor: undefined as { documentId?: Types.ObjectId; numero: string; cune: string; fecha: string } | undefined,
        predecesorDoc: null as PayrollEDocumentDocument | null,
        raizId: undefined as Types.ObjectId | undefined,
      };
    }

    const pred = modelo.predecesor;
    const predecesorDoc = await this.model
      .findOne({ 'emisor.nitNorm': nitNorm, cune: pred.cune })
      .exec();
    let periodo: string | undefined;
    let empleado: { docType?: string; docNumber?: string; name?: string } | undefined;
    if (modelo.tipoNota === TipoNota.Reemplazar) {
      const t = modelo.documento.trabajador;
      periodo = modelo.documento.periodo.fechaLiquidacionFin.slice(0, 7);
      empleado = {
        docType: t.tipoDocumento,
        docNumber: String(t.numeroDocumento).replace(/\D/g, ''),
        name: [t.primerNombre, t.otrosNombres, t.primerApellido, t.segundoApellido].filter(Boolean).join(' '),
      };
      // El ajuste corrige al MISMO trabajador y mes: otro es un documento nuevo, no un ajuste.
      if (predecesorDoc && (predecesorDoc.empleado?.docNumber !== empleado.docNumber || predecesorDoc.periodo !== periodo)) {
        throw new BadRequestException(
          'El trabajador o el mes del modelo no coinciden con los del documento que se quiere reemplazar.',
        );
      }
    } else if (predecesorDoc) {
      periodo = predecesorDoc.periodo;
      empleado = { ...(predecesorDoc.empleado as object) } as typeof empleado;
    } else {
      throw new BadRequestException(
        'Para eliminar un documento hay que conocer a su trabajador y su mes: el predecesor no está en BookiPos.',
      );
    }
    return {
      filtro: {
        'emisor.nitNorm': nitNorm,
        'predecesor.cune': pred.cune,
        tipoXml,
        tipoNota: modelo.tipoNota,
        vigente: true,
      },
      periodo: periodo!,
      empleado: empleado!,
      predecesor: { documentId: predecesorDoc?._id as Types.ObjectId | undefined, ...pred },
      predecesorDoc,
      raizId: predecesorDoc ? ((predecesorDoc.raizId ?? predecesorDoc._id) as Types.ObjectId) : undefined,
    };
  }

  /**
   * Un ajuste solo puede apuntar al ÚLTIMO documento aceptado y vigente de su
   * cadena (102 → 103 Reemplazar → …). Apuntar a uno ya reemplazado o a una
   * cadena eliminada se rechaza con un mensaje claro.
   */
  /**
   * Antes de crear o corregir un 103: repara cierres pendientes, comprueba que
   * el predecesor sea la cabeza de la cadena y que ningún OTRO ajuste no
   * rechazado (en curso o aceptado) ocupe ese predecesor. La garantía final
   * contra carreras es el índice único `nomina_103_un_ajuste_por_predecesor`.
   */
  private async verificarAjustable(
    ident: Awaited<ReturnType<NominaElectronicaService['identificar']>>,
    existente?: PayrollEDocumentDocument,
  ): Promise<void> {
    let pred = ident.predecesorDoc;
    if (!pred) return;
    if (pred.pendienteCierrePredecesor) {
      await this.repararCierre(pred);
      pred = await this.cargar(String(pred._id));
    }
    let ocupante = await this.model
      .findOne({ 'emisor.nitNorm': pred.emisor.nitNorm, 'predecesor.cune': pred.cune, tipoXml: '103', ocupaPredecesor: true })
      .exec();
    if (ocupante && String(ocupante._id) !== String(existente?._id) && ocupante.pendienteCierrePredecesor) {
      // Un ajuste aceptado cuyo cierre quedó pendiente: se repara antes de decidir.
      await this.repararCierre(ocupante);
      pred = await this.cargar(String(pred._id));
      ocupante = null;
    }
    this.assertEsCabezaDeCadena(pred);
    if (ocupante && String(ocupante._id) !== String(existente?._id)) throw this.ajusteEnCurso();
  }

  private ajusteEnCurso(): ConflictException {
    return new ConflictException('Ya hay un ajuste en curso o aceptado sobre ese documento.');
  }

  private assertEsCabezaDeCadena(pred: PayrollEDocumentDocument): void {
    if (pred.dianStatus !== 'accepted') {
      throw new BadRequestException('El documento que se quiere ajustar todavía no fue aceptado por la DIAN.');
    }
    if (pred.tipoXml === '103' && pred.tipoNota === TipoNota.Eliminar) {
      throw new BadRequestException(`El documento ${pred.fullNumber} es una eliminación: no se ajusta.`);
    }
    if (pred.superado) {
      throw new BadRequestException(
        `El documento ${pred.fullNumber} ya fue reemplazado por un ajuste posterior: ajusta el último documento aceptado de la cadena.`,
      );
    }
    if (pred.vigente === false) {
      throw new BadRequestException(`El documento ${pred.fullNumber} ya fue eliminado: no se puede ajustar.`);
    }
  }

  private async crearYTransmitir(
    modelo: ModeloNomina,
    tipoXml: '102' | '103',
    ident: Awaited<ReturnType<NominaElectronicaService['identificar']>>,
    ctx: ContextoNomina,
    sedeId: string,
    emisor: NonNullable<Awaited<ReturnType<FiscalEmittersService['obtenerPorSede']>>>,
    user?: JwtUser,
  ): Promise<ResultadoNominaElectronica> {
    const prefijo = PREFIJO_NOMINA[tipoXml];
    const counterId = contadorNomina(emisor.nitNorm, prefijo);
    const emisorId = emisor.id as string;
    const bloqueo = randomUUID();

    for (let intento = 1; ; intento++) {
      const numero = await this.siguienteNumero(counterId);
      let armado: ResultadoNomina;
      try {
        armado = this.armar(modelo, prefijo, numero, ctx);
      } catch (err) {
        await this.devolverNumero(counterId, numero);
        throw this.errorDeArmado(err);
      }
      let doc: PayrollEDocumentDocument;
      try {
        doc = await this.model.create({
          sedeId: new Types.ObjectId(sedeId),
          emisor: { name: emisor.razonSocial, nit: emisor.nit, nitNorm: emisor.nitNorm, nitDv: emisor.nitDv },
          empleado: ident.empleado,
          periodo: ident.periodo,
          tipoXml,
          ...(esAjuste(modelo) ? { tipoNota: modelo.tipoNota } : {}),
          prefix: prefijo,
          number: numero,
          fullNumber: armado.numero,
          issueDate: modelo.emision.fecha,
          issueTime: modelo.emision.hora,
          tipoAmbiente: ctx.tipoAmbiente,
          cune: armado.cune,
          totales: {
            devengadosCentavos: armado.totales.devengados,
            deduccionesCentavos: armado.totales.deducciones,
            comprobanteCentavos: armado.totales.comprobante,
          },
          ...(ident.predecesor ? { predecesor: ident.predecesor } : {}),
          ...(ident.raizId ? { raizId: ident.raizId } : {}),
          // Un 103 ocupa su predecesor hasta que la DIAN lo rechace (índice único parcial).
          ...(tipoXml === '103' ? { ocupaPredecesor: true } : {}),
          dianStatus: 'draft',
          vigente: true,
          createdByEmail: user?.email ?? 'sistema',
          // Nace bloqueado: nadie más lo firma ni lo transmite mientras esta llamada lo arma.
          bloqueoTransmision: bloqueo,
          bloqueoHasta: new Date(Date.now() + BLOQUEO_TRANSMISION_MS),
        });
      } catch (err) {
        if (!esDuplicado(err)) {
          await this.devolverNumero(counterId, numero);
          throw err;
        }
        const nombre = this.indiceDuplicado(err);
        if (nombre === 'consecutivo' && intento < MAX_REINTENTOS_NUMERO) continue; // el contador se atrasó: otro número
        await this.devolverNumero(counterId, numero);
        if (nombre === 'consecutivo') throw new ConflictException('No se pudo reservar el consecutivo de nómina.');
        if (nombre === 'ajuste') {
          // Otro 103 se quedó con el predecesor: si es el mismo ajuste, se devuelve el suyo; si es de otro tipo, 409.
          const mismo = await this.model.findOne(ident.filtro).exec();
          if (!mismo) throw this.ajusteEnCurso();
          return this.resultado(mismo, false, 'EN_CURSO', ['Otra emisión de este documento está en curso.']);
        }
        // Carrera: otra emisión del mismo documento ganó. Se devuelve el suyo, sin renumerar.
        const ganador = await this.model.findOne(ident.filtro).exec();
        if (!ganador) throw err;
        return this.resultado(ganador, false, 'EN_CURSO', ['Otra emisión de este documento está en curso.']);
      }
      try {
        return await this.firmarGuardarYTransmitir(doc, armado.cune, armado.xml, bloqueo, emisorId, 'draft');
      } finally {
        await this.soltarBloqueo(String(doc._id), bloqueo);
      }
    }
  }

  /** Borrador, rechazado o firmado sin XML: se vuelve a armar con el MISMO número. */
  private async regenerarYTransmitir(
    existente: PayrollEDocumentDocument,
    modelo: ModeloNomina,
    ctx: ContextoNomina,
    emisorId: string,
  ): Promise<ResultadoNominaElectronica> {
    const bloqueo = await this.tomarBloqueo(existente);
    if (!bloqueo) {
      const actual = await this.cargar(String(existente._id));
      return this.resultado(actual, false, 'EN_CURSO', ['Otra transmisión de este documento está en curso.']);
    }
    try {
      let armado: ResultadoNomina;
      try {
        armado = this.armar(modelo, existente.prefix, existente.number, ctx);
      } catch (err) {
        throw this.errorDeArmado(err);
      }
      let actualizado: PayrollEDocumentDocument;
      try {
        actualizado = await this.escribirOFallar(String(existente._id), existente.dianStatus, bloqueo.id, {
        $set: {
          cune: armado.cune,
          issueDate: modelo.emision.fecha,
          issueTime: modelo.emision.hora,
          tipoAmbiente: ctx.tipoAmbiente,
          ...(existente.tipoXml === '103' ? { ocupaPredecesor: true } : {}),
          totales: {
            devengadosCentavos: armado.totales.devengados,
            deduccionesCentavos: armado.totales.deducciones,
            comprobanteCentavos: armado.totales.comprobante,
          },
        },
        $unset: { rechazoMotivo: '' },
      });
      } catch (err) {
        // Otro 103 se quedó con el predecesor mientras este estaba rechazado.
        if (esDuplicado(err) && this.indiceDuplicado(err) === 'ajuste') throw this.ajusteEnCurso();
        throw err;
      }
      return await this.firmarGuardarYTransmitir(actualizado, armado.cune, armado.xml, bloqueo.id, emisorId, actualizado.dianStatus);
    } finally {
      await this.soltarBloqueo(String(existente._id), bloqueo.id);
    }
  }

  private armar(modelo: ModeloNomina, prefijo: string, consecutivo: number, ctx: ContextoNomina): ResultadoNomina {
    const emision = { ...modelo.emision, prefijo, consecutivo };
    if (esAjuste(modelo)) return armarNominaAjuste({ ...modelo, emision } as ModeloNominaAjuste, ctx);
    return armarNominaIndividual({ ...modelo, emision }, ctx);
  }

  private errorDeArmado(err: unknown): Error {
    // El armador valida el modelo (montos, fechas, predecesor): es un 400, no un 500.
    if (err instanceof DocumentoUblInvalidoError || (err as Error)?.name === 'DocumentoUblInvalidoError') {
      return new BadRequestException((err as Error).message);
    }
    return err as Error;
  }

  /**
   * Firma, guarda el XML firmado (bucket privado) y deja el documento en
   * `signed`; después transmite. Si no hay certificado utilizable el documento
   * queda en borrador con su número (el reintento lo reutiliza).
   */
  private async firmarGuardarYTransmitir(
    doc: PayrollEDocumentDocument,
    cune: string,
    xml: string,
    bloqueo: string,
    emisorId: string,
    desde: DianStatus,
  ): Promise<ResultadoNominaElectronica> {
    const docId = String(doc._id);
    let xmlFirmado: string;
    try {
      xmlFirmado = await this.firmante.firmar(xml, emisorId);
    } catch (err) {
      if (err instanceof FirmaNoDisponibleError || err instanceof ErrorFirma) {
        return this.sinRed(doc, [err.message], bloqueo);
      }
      throw err;
    }
    const { pathname } = await this.storage.guardarNomina(emisorId, docId, Buffer.from(xmlFirmado, 'utf8'));
    if (desde !== 'signed') assertTransicion(desde, 'signed');
    const firmado = await this.escribirOFallar(docId, desde, bloqueo, {
      $set: { dianStatus: 'signed', xmlPath: pathname, cune },
    });
    const ctx = await this.contexto(firmado.sedeId.toString(), {
      tipoXml: firmado.tipoXml,
      tipoAmbiente: firmado.tipoAmbiente,
      nitNorm: firmado.emisor.nitNorm,
      cune: firmado.cune,
    });
    if (!ctx.ok) return this.sinRed(firmado, ctx.motivos, bloqueo);
    return this.enviarConBloqueo(firmado, xmlFirmado, bloqueo, new Date(Date.now() + BLOQUEO_TRANSMISION_MS), ctx);
  }

  // ── Transmisión ────────────────────────────────────────────────────────────

  /** Documento ya generado: reenvía el MISMO XML firmado o consulta si ya está en vuelo con trackId. */
  private async transmitirExistente(doc: PayrollEDocumentDocument): Promise<ResultadoNominaElectronica> {
    if (doc.dianStatus === 'accepted') {
      await this.repararCierre(doc);
      return this.resultado(doc, false, undefined, ['El documento ya fue aceptado por la DIAN.']);
    }
    if (doc.dianStatus === 'rejected') {
      throw new BadRequestException('El documento fue rechazado: corrígelo y vuelve a emitirlo (conserva su número).');
    }
    if (doc.dianStatus !== 'signed' && doc.dianStatus !== 'sent') {
      throw new BadRequestException('El documento aún no está firmado: se genera de nuevo desde la emisión.');
    }
    const docId = String(doc._id);
    const ctx = await this.contexto(doc.sedeId.toString(), {
      tipoXml: doc.tipoXml,
      tipoAmbiente: doc.tipoAmbiente,
      nitNorm: doc.emisor.nitNorm,
      cune: doc.cune,
    });
    if (!ctx.ok) return this.sinRed(doc, ctx.motivos);
    const bloqueo = await this.tomarBloqueo(doc);
    if (!bloqueo) {
      const actual = await this.cargar(docId);
      return this.resultado(actual, false, 'EN_CURSO', ['Otra transmisión de este documento está en curso.']);
    }
    try {
      const hasta = bloqueo.doc.bloqueoHasta ?? new Date(Date.now() + BLOQUEO_TRANSMISION_MS);
      // En vuelo con trackId (set de pruebas asíncrono): se consulta, no se reenvía.
      if (bloqueo.doc.dianStatus === 'sent' && bloqueo.doc.trackId) {
        return await this.consultarVeredicto(bloqueo.doc, ctx.transmisor, hasta, bloqueo.id);
      }
      if (!bloqueo.doc.xmlPath) {
        throw new ConflictException('El documento está firmado sin XML guardado: no se rearma ni se renumera. Revisión manual.');
      }
      const xmlFirmado = (await this.storage.leerNominaGuardada(bloqueo.doc.xmlPath, docId)).toString('utf8');
      return await this.enviarConBloqueo(bloqueo.doc, xmlFirmado, bloqueo.id, hasta, ctx);
    } finally {
      await this.soltarBloqueo(docId, bloqueo.id);
    }
  }

  /**
   * NO REORDENAR (igual que la factura): `sent` + intento se persisten ANTES
   * de la red; el veredicto se aplica con la máquina de estados.
   */
  private async enviarConBloqueo(
    inicial: PayrollEDocumentDocument,
    xmlFirmado: string,
    bloqueo: string,
    bloqueoHasta: Date,
    ctx: { transmisor: TransmisorDian; ambiente: '1' | '2'; testSetId?: string },
  ): Promise<ResultadoNominaElectronica> {
    let doc = inicial;
    const docId = String(doc._id);
    const estado = doc.dianStatus;
    if (this.presupuestoRed(bloqueoHasta) < PRESUPUESTO_RED_MIN_MS) {
      return this.resultado(doc, false, 'RED', ['Se agotó el tiempo de la transmisión antes de enviar; inténtalo de nuevo.']);
    }
    assertTransicion(estado, 'sent');
    doc = await this.escribirOFallar(docId, estado, bloqueo, {
      $set: { dianStatus: 'sent', enviadoAt: new Date() },
      $inc: { intentos: 1 },
    });

    const tipo = doc.tipoXml === '103' ? 'payroll_adjustment' : 'payroll';
    const base = { tipo, fullNumber: doc.fullNumber, cufe: doc.cune, xmlFirmado } as const;
    const envio = await this.llamar(bloqueoHasta, (presupuesto) =>
      ctx.ambiente === '2'
        ? ctx.transmisor.enviarSetPruebas({ ...base, testSetId: ctx.testSetId, ...presupuesto })
        : ctx.transmisor.enviar({ ...base, ...presupuesto }),
    );
    let r = envio.respuesta;
    if (r.codigo === 'YA_PROCESADO_DIAN') {
      // La DIAN ya lo procesó: su veredicto se consulta, nunca se rechaza ni se renumera.
      r = (await this.llamar(bloqueoHasta, (p) => ctx.transmisor.consultar({ cufe: doc.cune, ...p }))).respuesta;
    }
    return this.aplicarVeredicto(doc, r, envio.salio, bloqueo);
  }

  /** Consulta en la DIAN un documento en vuelo y aplica el veredicto. */
  private async consultarVeredicto(
    doc: PayrollEDocumentDocument,
    transmisor: TransmisorDian,
    bloqueoHasta: Date,
    bloqueo?: string,
  ): Promise<ResultadoNominaElectronica> {
    const consulta = await this.llamar(bloqueoHasta, (p) =>
      transmisor.consultar({ trackId: doc.trackId, cufe: doc.cune, ...p }),
    );
    return this.aplicarVeredicto(doc, consulta.respuesta, consulta.salio, bloqueo);
  }

  private async aplicarVeredicto(
    doc: PayrollEDocumentDocument,
    r: RespuestaDian,
    transmitido: boolean,
    bloqueo?: string,
  ): Promise<ResultadoNominaElectronica> {
    const docId = String(doc._id);
    const destino = this.destino(r);
    const set: Record<string, unknown> = { dianStatus: destino, respuestaDian: this.limpiar(r) };
    if (r.trackId) set.trackId = r.trackId;
    if (r.zipKey) set.zipKey = r.zipKey;
    if (destino === 'rejected') {
      set.rechazoMotivo = this.motivoRechazo(r);
      // Un rechazo suelta el predecesor: se puede corregir (mismo tipo) o cambiar de idea.
      if (doc.tipoXml === '103') set.ocupaPredecesor = false;
    }
    const update: UpdateQuery<PayrollEDocumentDocument> = { $set: set };
    if (destino === 'accepted') {
      update.$unset = { rechazoMotivo: '' };
      // Un 103 aceptado deja anotado, en la misma escritura, que falta cerrar su cadena.
      if (doc.tipoXml === '103') set.pendienteCierrePredecesor = true;
    }
    // Sin bloqueo (consulta): solo si sigue en vuelo; el veredicto es final y se aplica una vez.
    const final = await this.model
      .findOneAndUpdate(
        { _id: docId, dianStatus: 'sent', ...(bloqueo ? { bloqueoTransmision: bloqueo } : {}) },
        update,
        { returnDocument: 'after' },
      )
      .exec();
    if (!final) {
      this.logger.error(`Nómina ${docId}: no se pudo guardar el veredicto (${destino}); queda en vuelo.`);
      return this.resultado(doc, transmitido, r.codigo, r.mensajes);
    }
    if (final.dianStatus === 'accepted') await this.repararCierre(final);
    return this.resultado(final, transmitido, r.codigo, r.mensajes);
  }

  /**
   * Cierra la cadena de un 103 aceptado, de forma idempotente:
   *  - Reemplazar: el predecesor queda `superado` (la vigencia pasa a este 103).
   *  - Eliminar: TODA la cadena (el 102 raíz y cada 103) deja de ser vigente y
   *    el mes se libera para volver a emitirse.
   * Si falla, el 103 conserva `pendienteCierrePredecesor` y el siguiente
   * `consultar`/`transmitir`/`emitir` lo repara.
   */
  private async repararCierre(doc: PayrollEDocumentDocument): Promise<void> {
    if (doc.tipoXml !== '103' || !doc.pendienteCierrePredecesor) return;
    try {
      const predId = doc.predecesor?.documentId;
      if (doc.tipoNota === TipoNota.Eliminar) {
        const raiz = doc.raizId ?? predId;
        if (raiz) {
          await this.model
            .updateMany({ $or: [{ _id: raiz }, { raizId: raiz }] }, { $set: { vigente: false, superado: true } })
            .exec();
        }
      } else if (predId) {
        // El 102 raíz sigue ocupando el mes (vigente); un 103 superado deja de serlo.
        await this.model.updateOne({ _id: predId }, { $set: { superado: true } }).exec();
        await this.model.updateOne({ _id: predId, tipoXml: '103' }, { $set: { vigente: false } }).exec();
      }
      await this.model.updateOne({ _id: doc._id }, { $unset: { pendienteCierrePredecesor: '' } }).exec();
    } catch (err) {
      this.logger.warn(
        `Nómina ${String(doc._id)}: no se pudo cerrar la cadena (${(err as Error).name}); queda pendiente y se repara luego.`,
      );
    }
  }

  // ── Gate de ambiente y transmisor ──────────────────────────────────────────

  private decidir(
    estado: EstadoNomina,
    nitNorm: string | undefined,
    tipoXml: '102' | '103',
    tipoAmbiente: string,
    cune: string | undefined,
  ) {
    const falta = [...estado.faltaParaTransmitir];
    // Habilitación (ambiente 2) envía al set de pruebas de NÓMINA: sin su TestSetId no hay envío.
    if (estado.tipoAmbiente === '2' && !estado.testSetId) falta.push('TestSetId del set de pruebas de nómina');
    return decidirAmbiente({
      emisor: {
        tipoAmbiente: estado.tipoAmbiente,
        habilitado: estado.habilitado,
        nitNorm,
        faltaParaTransmitir: falta,
      },
      // La nómina no usa resolución de numeración de la DIAN.
      resolucion: null,
      documento: {
        tipo: tipoXml === '103' ? 'payroll_adjustment' : 'payroll',
        tipoAmbiente,
        nitNorm,
        cufe: cune,
      },
    });
  }

  /** Gate + transmisor de NÓMINA para un documento ya generado. */
  private async contexto(
    sedeId: string,
    doc: { tipoXml?: '102' | '103'; tipoAmbiente?: string; nitNorm?: string; cune?: string },
  ): Promise<
    | { ok: true; transmisor: TransmisorDian; ambiente: '1' | '2'; testSetId?: string }
    | { ok: false; motivos: string[] }
  > {
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor) return { ok: false, motivos: ['la sede no tiene emisor fiscal'] };
    const estado = await this.emisores.estadoNomina(emisor.id as string);
    const decision = this.decidir(estado, doc.nitNorm, doc.tipoXml ?? '102', doc.tipoAmbiente ?? '', doc.cune);
    if (!decision.permitido) return { ok: false, motivos: decision.motivos };
    let transmisor: TransmisorDian;
    try {
      transmisor = await this.transmisores.para(sedeId, decision.ambiente);
    } catch (err) {
      if (err instanceof AmbienteNoCoincideError) return { ok: false, motivos: [err.message] };
      throw err;
    }
    if (transmisor instanceof StubDian) {
      // El stub nunca sale a la red: ni se marca `sent`.
      const r = await transmisor.enviar({ tipo: 'payroll', fullNumber: '-' });
      return { ok: false, motivos: r.mensajes };
    }
    return { ok: true, transmisor, ambiente: decision.ambiente, testSetId: estado.testSetId };
  }

  // ── Persistencia condicionada ──────────────────────────────────────────────

  private async cargar(docId: string): Promise<PayrollEDocumentDocument> {
    const doc = Types.ObjectId.isValid(docId) ? await this.model.findById(docId).exec() : null;
    if (!doc) throw new NotFoundException('Documento de nómina electrónica no encontrado');
    return doc;
  }

  private async tomarBloqueo(
    doc: PayrollEDocumentDocument,
  ): Promise<{ id: string; doc: PayrollEDocumentDocument } | null> {
    const id = randomUUID();
    const ahora = new Date();
    const tomado = await this.model
      .findOneAndUpdate(
        {
          _id: doc._id,
          dianStatus: doc.dianStatus,
          $or: [{ bloqueoTransmision: null }, { bloqueoHasta: { $lte: ahora } }],
        },
        { $set: { bloqueoTransmision: id, bloqueoHasta: new Date(ahora.getTime() + BLOQUEO_TRANSMISION_MS) } },
        { returnDocument: 'after' },
      )
      .exec();
    return tomado ? { id, doc: tomado } : null;
  }

  private async soltarBloqueo(docId: string, bloqueo: string): Promise<void> {
    try {
      await this.model
        .updateOne({ _id: docId, bloqueoTransmision: bloqueo }, { $unset: { bloqueoTransmision: '', bloqueoHasta: '' } })
        .exec();
    } catch (err) {
      this.logger.warn(`Nómina ${docId}: no se pudo soltar el bloqueo (${(err as Error).name}).`);
    }
  }

  private async escribirOFallar(
    docId: string,
    desde: DianStatus,
    bloqueo: string,
    update: UpdateQuery<PayrollEDocumentDocument>,
  ): Promise<PayrollEDocumentDocument> {
    const doc = await this.model
      .findOneAndUpdate({ _id: docId, dianStatus: desde, bloqueoTransmision: bloqueo }, update, { returnDocument: 'after' })
      .exec();
    if (!doc) {
      throw new ConflictException('El documento cambió mientras se transmitía; no se envió. Inténtalo de nuevo.');
    }
    return doc;
  }

  /** Nada salió a la red: deja constancia de por qué sin mover el estado. */
  private async sinRed(
    doc: PayrollEDocumentDocument,
    motivos: string[],
    bloqueo?: string,
  ): Promise<ResultadoNominaElectronica> {
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

  // ── Consecutivo propio, atómico ────────────────────────────────────────────

  private async siguienteNumero(counterId: string): Promise<number> {
    const c = await this.counters
      .findOneAndUpdate({ _id: counterId }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' })
      .exec();
    return c?.seq ?? 1;
  }

  /** Devuelve el número solo si nadie tomó otro después. */
  private async devolverNumero(counterId: string, seq: number): Promise<void> {
    await this.counters.findOneAndUpdate({ _id: counterId, seq }, { $inc: { seq: -1 } }).exec();
  }

  private indiceDuplicado(err: unknown): 'consecutivo' | 'ajuste' | 'otro' {
    const e = err as { keyPattern?: Record<string, unknown>; message?: string };
    const claves = Object.keys(e.keyPattern ?? {});
    if (claves.includes('number') || (e.message ?? '').includes('nomina_consecutivo_unico')) return 'consecutivo';
    if (claves.includes('predecesor.cune') || (e.message ?? '').includes('nomina_103_un_ajuste_por_predecesor')) return 'ajuste';
    return 'otro';
  }

  // ── Red y respuesta ────────────────────────────────────────────────────────

  presupuestoRed(bloqueoHasta: Date, ahora: number = Date.now()): number {
    return Math.min(PRESUPUESTO_RED_MAX_MS, bloqueoHasta.getTime() - ahora - MARGEN_BLOQUEO_MS);
  }

  /** Una excepción del adaptador es un fallo de red, nunca un veredicto. */
  private async llamar(
    bloqueoHasta: Date,
    fn: (p: { presupuestoMs: number; signal: AbortSignal }) => Promise<RespuestaDian>,
  ): Promise<{ respuesta: RespuestaDian; salio: boolean }> {
    const presupuestoMs = this.presupuestoRed(bloqueoHasta);
    const enVuelo = (mensaje: string): RespuestaDian => ({ ok: false, codigo: 'RED', origen: 'adapter', mensajes: [mensaje] });
    if (presupuestoMs <= 0) {
      return { salio: false, respuesta: enVuelo('Se agotó el tiempo de la transmisión; el documento queda en vuelo.') };
    }
    const control = new AbortController();
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const vencido = new Promise<RespuestaDian>((resolve) => {
      reloj = setTimeout(() => {
        control.abort();
        resolve(enVuelo('La DIAN no respondió dentro del presupuesto; el documento queda en vuelo.'));
      }, presupuestoMs);
    });
    try {
      const intento = Promise.resolve().then(() => fn({ presupuestoMs, signal: control.signal }));
      intento.catch(() => undefined);
      return { salio: true, respuesta: await Promise.race([intento, vencido]) };
    } catch (err) {
      this.logger.warn(`Fallo del transmisor DIAN (${(err as Error)?.name ?? 'Error'}).`);
      return { salio: true, respuesta: enVuelo('No hubo respuesta de la DIAN; el documento queda en vuelo.') };
    } finally {
      clearTimeout(reloj);
    }
  }

  private destino(r: RespuestaDian): DianStatus {
    try {
      return estadoTrasRespuesta('sent', r);
    } catch {
      this.logger.warn('Respuesta del transmisor DIAN fuera de contrato: el documento queda en vuelo.');
      return 'sent';
    }
  }

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
    if (r.cufe) limpia.cune = String(r.cufe).slice(0, 200);
    if (r.ok === true && typeof r.applicationResponse === 'string' && r.applicationResponse.length <= MAX_B64_APPLICATION_RESPONSE) {
      limpia.applicationResponse = r.applicationResponse;
    }
    return limpia;
  }

  private motivoRechazo(r: RespuestaDian): string {
    const texto = (r.mensajes ?? []).slice(0, MAX_MENSAJES).join('; ').slice(0, 1000);
    return texto || r.codigo || 'Rechazado por la DIAN';
  }

  private configFaltante(motivos: string[]): ResultadoNominaElectronica {
    return { transmitido: false, codigo: 'CONFIG_FALTANTE', mensajes: motivos, intentos: 0 };
  }

  private resultado(
    doc: PayrollEDocumentDocument,
    transmitido: boolean,
    codigo: string | undefined,
    mensajes: string[],
  ): ResultadoNominaElectronica {
    return {
      documentoId: String(doc._id),
      fullNumber: doc.fullNumber,
      tipoXml: doc.tipoXml,
      periodo: doc.periodo,
      dianStatus: doc.dianStatus,
      cune: doc.cune,
      transmitido,
      codigo,
      mensajes,
      intentos: doc.intentos ?? 0,
    };
  }

  /** Una fila por operación: quién, qué documento, qué resultó. Sin secretos ni XML. */
  private async auditar(
    action: string,
    user: JwtUser | undefined,
    docId: string,
    success: boolean,
    codigo: string,
    r?: ResultadoNominaElectronica,
    metodo: 'GET' | 'POST' = 'POST',
  ): Promise<void> {
    const documentoId = String(docId).slice(0, 64);
    const detail: Record<string, string> = { documentoId, codigo: String(codigo).slice(0, 60) };
    if (r?.fullNumber) detail.fullNumber = r.fullNumber;
    if (r) {
      detail.intento = String(r.intentos);
      if (r.dianStatus) detail.dianStatus = r.dianStatus;
      detail.transmitido = String(r.transmitido);
    }
    await this.audit.record({
      userId: user?.userId,
      userEmail: user?.email,
      userName: user ? user.name : 'SYSTEM',
      role: user ? user.role : 'SYSTEM',
      method: user ? metodo : 'SERVER',
      path:
        action === 'einvoicing.nomina.transmitida'
          ? `/einvoicing/nomina/${documentoId}/transmitir`
          : `/einvoicing/nomina/${documentoId}`,
      success,
      action,
      detail,
    });
  }
}
