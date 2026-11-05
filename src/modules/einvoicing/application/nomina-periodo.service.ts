import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PayrollEDocument, type PayrollEDocumentDocument } from '../infrastructure/schemas/payroll-e-document.schema';
import { PayrollRun, type PayrollRunDocument } from '../../payroll/infrastructure/schemas/payroll-run.schema';
import { PayrollDeduction, type PayrollDeductionDocument } from '../../payroll/infrastructure/schemas/payroll-deduction.schema';
import { Sede, type SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { EmployeesService } from '../../employees/application/employees.service';
import { FiscalEmittersService } from './fiscal-emitters.service';
import { NominaElectronicaService, type ResultadoNominaElectronica } from './nomina-electronica.service';
import {
  consolidarNominaMes,
  type CorridaColilla,
  type DeduccionConsolidar,
  type EmpleadoConsolidar,
  type EntradaConsolidar,
} from '../domain/nomina/consolidar';
import { empleadorDeEmisor, relojColombia, type ResultadoEmpleador } from '../domain/nomina/empleador';
import { TipoNota, type DocumentoNe, type EmisionNe } from '../domain/nomina/modelo';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { allowedSedeIds, assertSedeAccess } from '../../core-auth/domain/sede-access';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { AuditService } from '../../core-audit/application/audit.service';

/**
 * Lote de emisión por llamada. Cada documento firma y sale a la red (hasta
 * ~25 s de presupuesto de red), y la función de Vercel tiene un tope de
 * tiempo: se emite de a pocos con cursor y el cliente repite hasta agotarlo.
 */
export const LOTE_EMISION_POR_DEFECTO = 3;
export const LOTE_EMISION_MAX = 5;

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface PrevueloTrabajador {
  empleadoId: string;
  nombre: string;
  ok: boolean;
  bloqueos: string[];
  advertencias: string[];
  documentoExistente?: { id: string; fullNumber: string; dianStatus: string };
}

export type ResultadoTrabajadorEmision =
  | { empleadoId: string; nombre: string; estado: 'existente' | 'emitido' | 'en_curso' | 'bloqueado' | 'error'; documentoId?: string; fullNumber?: string; dianStatus?: string; mensajes: string[] };

export interface ResultadoEmisionPeriodo {
  periodo: string;
  resultados: ResultadoTrabajadorEmision[];
  /** Cursor para la siguiente llamada; ausente si ya no quedan trabajadores. */
  siguienteCursor?: string;
  pendientes: number;
}

export interface VistaDocumentoNomina {
  id: string;
  fullNumber: string;
  tipoXml: '102' | '103';
  tipoNota?: 1 | 2;
  periodo: string;
  empleado: { nombre?: string; documento: string };
  dianStatus: string;
  vigente: boolean;
  superado: boolean;
  issueDate: string;
  rechazoMotivo?: string;
}

interface ContextoPeriodo {
  periodo: string;
  sedeId: string;
  emisor: { nitNorm: string; razonSocial?: string; municipioDane?: string; direccion?: string };
  empleador: Extract<ResultadoEmpleador, { ok: true }>['empleador'];
  /** Sedes del emisor a las que el usuario puede llegar. */
  sedes: string[];
  empleados: Map<string, EmpleadoConsolidar & { sedeId?: string }>;
  corridas: LeanRun[];
}

interface LeanRun {
  _id: Types.ObjectId;
  period: string;
  coverage: string;
  status: string;
  sedeId?: Types.ObjectId;
  slips: {
    employeeId: string;
    employeeName?: string;
    sedeId?: Types.ObjectId;
    diasTrabajados: number;
    salaryType?: string;
    breakdown: never;
    otrasDeduccionesDetalle?: { concept: string; amount: number; source?: string }[];
  }[];
}

const enmascarar = (doc: string): string => (doc.length <= 4 ? '••••' : `••••${doc.slice(-4)}`);

/**
 * Nómina electrónica por PERIODO: pre-vuelo, emisión en lotes, listado y
 * ajustes (103) de los documentos del mes. Orquesta el consolidador (puro) y
 * `NominaElectronicaService` (firma, numeración, transmisión, cadena).
 *
 * Tenancy y sedes: todo corre en el `TenantContext` de la request y se limita
 * a las sedes del emisor a las que el usuario tiene acceso.
 */
@Injectable()
export class NominaPeriodoService {
  constructor(
    @InjectModel(PayrollEDocument.name) private readonly docs: Model<PayrollEDocumentDocument>,
    @InjectModel(PayrollRun.name) private readonly runs: Model<PayrollRunDocument>,
    @InjectModel(PayrollDeduction.name) private readonly deducciones: Model<PayrollDeductionDocument>,
    @InjectModel(Sede.name) private readonly sedes: Model<SedeDocument>,
    private readonly empleados: EmployeesService,
    private readonly emisores: FiscalEmittersService,
    private readonly nomina: NominaElectronicaService,
    private readonly audit: AuditService,
  ) {}

  // ── Pre-vuelo ─────────────────────────────────────────────────────────────

  async preparar(periodo: string, sedeId: string, user: JwtUser): Promise<{ periodo: string; trabajadores: PrevueloTrabajador[] }> {
    TenantContext.currentOrThrow();
    const ctx = await this.contexto(periodo, sedeId, user);
    const ids = this.trabajadores(ctx);
    const existentes = await this.existentes(ctx, ids);
    const trabajadores: PrevueloTrabajador[] = [];
    for (const id of ids) {
      const r = await this.consolidar(ctx, id);
      trabajadores.push({
        empleadoId: id,
        nombre: this.nombre(ctx, id),
        ok: r.ok,
        bloqueos: r.ok ? [] : r.bloqueos,
        advertencias: r.ok ? r.advertencias : [],
        ...this.refExistente(existentes.get(id)),
      });
    }
    await this.auditar('einvoicing.nomina.periodo.preparada', user, `/einvoicing/nomina/periodos/${periodo}/preparar`, {
      periodo,
      sedeId,
      trabajadores: String(trabajadores.length),
      bloqueados: String(trabajadores.filter((t) => !t.ok).length),
    });
    return { periodo, trabajadores };
  }

  // ── Emisión en lotes ──────────────────────────────────────────────────────

  async emitir(
    periodo: string,
    sedeId: string,
    user: JwtUser,
    opciones: { cursor?: string; limite?: number } = {},
  ): Promise<ResultadoEmisionPeriodo> {
    TenantContext.currentOrThrow();
    const ctx = await this.contexto(periodo, sedeId, user);
    const todos = this.trabajadores(ctx);
    const limite = Math.min(Math.max(opciones.limite ?? LOTE_EMISION_POR_DEFECTO, 1), LOTE_EMISION_MAX);
    const restantes = opciones.cursor ? todos.filter((id) => id > opciones.cursor!) : todos;
    const lote = restantes.slice(0, limite);
    const existentes = await this.existentes(ctx, lote);
    const resultados: ResultadoTrabajadorEmision[] = [];
    for (const id of lote) {
      resultados.push(await this.emitirUno(ctx, id, existentes.get(id), user));
    }
    const pendientes = restantes.length - lote.length;
    await this.auditar('einvoicing.nomina.periodo.emitida', user, `/einvoicing/nomina/periodos/${periodo}/emitir`, {
      periodo,
      sedeId,
      lote: String(lote.length),
      pendientes: String(pendientes),
    });
    return {
      periodo,
      resultados,
      pendientes,
      ...(pendientes > 0 ? { siguienteCursor: lote[lote.length - 1] } : {}),
    };
  }

  private async emitirUno(
    ctx: ContextoPeriodo,
    id: string,
    existente: PayrollEDocumentDocument | undefined,
    user: JwtUser,
  ): Promise<ResultadoTrabajadorEmision> {
    const nombre = this.nombre(ctx, id);
    // Idempotencia: un 102 ya aceptado se devuelve tal cual, sin tocar la red ni el consecutivo.
    if (existente?.dianStatus === 'accepted') {
      return { empleadoId: id, nombre, estado: 'existente', documentoId: String(existente._id), fullNumber: existente.fullNumber, dianStatus: 'accepted', mensajes: ['Ya estaba aceptado por la DIAN.'] };
    }
    const r = await this.consolidar(ctx, id);
    if (!r.ok) return { empleadoId: id, nombre, estado: 'bloqueado', mensajes: r.bloqueos };
    try {
      const res = await this.nomina.emitir({ emision: this.emision(ctx), documento: r.modelo }, ctx.sedeId, user);
      if (res.documentoId) {
        // Deja a quién pertenece el documento: el ajuste recalcula desde ahí.
        await this.docs
          .updateOne({ _id: res.documentoId, 'empleado.employeeId': null }, { $set: { 'empleado.employeeId': new Types.ObjectId(id) } })
          .exec();
      }
      return this.deResultado(id, nombre, res, r.advertencias);
    } catch (err) {
      return { empleadoId: id, nombre, estado: 'error', mensajes: [this.mensajeError(err)] };
    }
  }

  // ── Listado ───────────────────────────────────────────────────────────────

  async listar(periodo: string, sedeId: string, user: JwtUser): Promise<VistaDocumentoNomina[]> {
    TenantContext.currentOrThrow();
    const { emisor, sedes } = await this.alcance(periodo, sedeId, user);
    const filas = await this.docs
      .find({
        'emisor.nitNorm': emisor.nitNorm,
        periodo,
        sedeId: { $in: sedes.map((s) => new Types.ObjectId(s)) },
      })
      .sort({ 'empleado.docNumber': 1, createdAt: 1 })
      .exec();
    return filas.map((d) => ({
      id: String(d._id),
      fullNumber: d.fullNumber,
      tipoXml: d.tipoXml,
      ...(d.tipoNota ? { tipoNota: d.tipoNota } : {}),
      periodo: d.periodo,
      empleado: { nombre: d.empleado?.name, documento: enmascarar(d.empleado?.docNumber ?? '') },
      dianStatus: d.dianStatus,
      vigente: d.vigente !== false,
      superado: d.superado === true,
      issueDate: d.issueDate,
      ...(d.rechazoMotivo ? { rechazoMotivo: d.rechazoMotivo } : {}),
    }));
  }

  // ── Ajustes ───────────────────────────────────────────────────────────────

  async ajustar(docId: string, tipoNota: 'reemplazar' | 'eliminar', user: JwtUser): Promise<ResultadoNominaElectronica> {
    TenantContext.currentOrThrow();
    const doc = Types.ObjectId.isValid(docId) ? await this.docs.findById(docId).exec() : null;
    if (!doc) throw new NotFoundException('Documento de nómina electrónica no encontrado');
    const sedeId = doc.sedeId.toString();
    assertSedeAccess(user, sedeId);
    try {
      const cabeza = await this.cabezaDeCadena(doc);
      const r =
        tipoNota === 'eliminar'
          ? await this.eliminar(cabeza, sedeId, user)
          : await this.reemplazar(cabeza, sedeId, user);
      await this.auditar(
        'einvoicing.nomina.ajustada',
        user,
        `/einvoicing/nomina/${docId}/ajuste`,
        { documentoId: docId, tipoNota, resultado: r.dianStatus ?? r.codigo ?? '-' },
      );
      return r;
    } catch (err) {
      await this.auditar(
        'einvoicing.nomina.ajustada',
        user,
        `/einvoicing/nomina/${docId}/ajuste`,
        { documentoId: docId, tipoNota, error: ((err as Error)?.name ?? 'Error').slice(0, 60) },
        false,
      );
      throw err;
    }
  }

  /** El último documento aceptado y vigente de la cadena del documento pedido. */
  private async cabezaDeCadena(doc: PayrollEDocumentDocument): Promise<PayrollEDocumentDocument> {
    const raiz = doc.raizId ?? doc._id;
    const cabeza = await this.docs
      .findOne({
        $or: [{ _id: raiz }, { raizId: raiz }],
        dianStatus: 'accepted',
        vigente: true,
        superado: { $ne: true },
      })
      .sort({ createdAt: -1 })
      .exec();
    if (!cabeza) {
      throw new BadRequestException('La cadena de este documento no tiene un documento aceptado y vigente que ajustar (está eliminada o aún sin aceptar).');
    }
    return cabeza;
  }

  private async eliminar(cabeza: PayrollEDocumentDocument, sedeId: string, user: JwtUser): Promise<ResultadoNominaElectronica> {
    const ctx = await this.contextoDeDocumento(cabeza, sedeId, user);
    return this.nomina.emitir(
      { tipoNota: TipoNota.Eliminar, emision: this.emision(ctx), predecesor: this.predecesor(cabeza) },
      sedeId,
      user,
    );
  }

  private async reemplazar(cabeza: PayrollEDocumentDocument, sedeId: string, user: JwtUser): Promise<ResultadoNominaElectronica> {
    const ctx = await this.contextoDeDocumento(cabeza, sedeId, user);
    const empleadoId = this.empleadoDeDocumento(ctx, cabeza);
    // Recalcula desde las corridas actuales (p. ej. se reabrió una y se volvió a cerrar).
    const r = await this.consolidar(ctx, empleadoId);
    if (!r.ok) {
      throw new ConflictException(`No se puede reemplazar: ${r.bloqueos.join(' ')}`);
    }
    return this.nomina.emitir(
      { tipoNota: TipoNota.Reemplazar, emision: this.emision(ctx), predecesor: this.predecesor(cabeza), documento: r.modelo },
      sedeId,
      user,
    );
  }

  private predecesor(d: PayrollEDocumentDocument) {
    return { numero: d.fullNumber, cune: d.cune, fecha: d.issueDate };
  }

  private empleadoDeDocumento(ctx: ContextoPeriodo, d: PayrollEDocumentDocument): string {
    const directo = d.empleado?.employeeId ? String(d.empleado.employeeId) : undefined;
    if (directo && ctx.empleados.has(directo)) return directo;
    const doc = (d.empleado?.docNumber ?? '').replace(/\D/g, '');
    for (const [id, e] of ctx.empleados) {
      if (doc && (e.docNumber ?? '').replace(/\D/g, '') === doc) return id;
    }
    throw new ConflictException('El trabajador de este documento ya no está en BookiPos: solo se puede eliminar, no reemplazar.');
  }

  // ── Contexto y datos ──────────────────────────────────────────────────────

  private async alcance(periodo: string, sedeId: string, user: JwtUser) {
    if (!PERIODO.test(periodo ?? '')) throw new BadRequestException('periodo debe ser un mes YYYY-MM');
    if (!sedeId || !Types.ObjectId.isValid(sedeId)) throw new BadRequestException('sedeId es obligatorio');
    assertSedeAccess(user, sedeId);
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor) throw new ConflictException('La sede no tiene emisor fiscal.');
    const delEmisor = await this.sedes.find({ emisorId: emisor._id }).exec();
    const limitadas = allowedSedeIds(user);
    const sedes = delEmisor.map((s) => String(s._id)).filter((id) => limitadas === null || limitadas.includes(id));
    if (!sedes.includes(sedeId)) sedes.push(sedeId);
    return { emisor, sedes };
  }

  private async contexto(periodo: string, sedeId: string, user: JwtUser): Promise<ContextoPeriodo> {
    const { emisor, sedes } = await this.alcance(periodo, sedeId, user);
    const empleador = empleadorDeEmisor(emisor);
    if (!empleador.ok) throw new ConflictException(`Falta configurar: ${empleador.motivos.join('; ')}.`);
    const corridas = (await this.runs.find({ period: periodo }).lean().exec()) as unknown as LeanRun[];
    const lista = await this.empleados.list();
    const empleados = new Map<string, EmpleadoConsolidar & { sedeId?: string }>();
    for (const e of lista) {
      const plano = (typeof e.toObject === 'function' ? e.toObject() : e) as unknown as EmpleadoConsolidar & { sedeId?: Types.ObjectId };
      empleados.set(String(e._id), { ...plano, id: String(e._id), sedeId: plano.sedeId ? String(plano.sedeId) : undefined });
    }
    return { periodo, sedeId, emisor, empleador: empleador.empleador, sedes, empleados, corridas };
  }

  /** Contexto para ajustar un documento ya emitido: el de su mes. */
  private contextoDeDocumento(d: PayrollEDocumentDocument, sedeId: string, user: JwtUser): Promise<ContextoPeriodo> {
    return this.contexto(d.periodo, sedeId, user);
  }

  /** Sede efectiva de una colilla: la suya, la de la corrida o la del expediente. */
  private sedeDe(ctx: ContextoPeriodo, run: LeanRun, slip: LeanRun['slips'][number], empleadoId: string): string | undefined {
    const s = slip.sedeId ?? run.sedeId;
    return s ? String(s) : ctx.empleados.get(empleadoId)?.sedeId;
  }

  /** Trabajadores con colilla en una corrida CERRADA del mes, dentro de las sedes del emisor al alcance. Orden estable (el cursor). */
  private trabajadores(ctx: ContextoPeriodo): string[] {
    const ids = new Set<string>();
    for (const run of ctx.corridas) {
      if (run.status !== 'cerrada') continue;
      for (const slip of run.slips) {
        const sede = this.sedeDe(ctx, run, slip, slip.employeeId);
        if (sede && ctx.sedes.includes(sede)) ids.add(slip.employeeId);
      }
    }
    return [...ids].sort();
  }

  private nombre(ctx: ContextoPeriodo, id: string): string {
    for (const run of ctx.corridas) {
      const s = run.slips.find((x) => x.employeeId === id);
      if (s?.employeeName) return s.employeeName;
    }
    const e = ctx.empleados.get(id);
    return e ? [e.firstName, e.lastName].filter(Boolean).join(' ') : id;
  }

  private async consolidar(ctx: ContextoPeriodo, id: string) {
    const empleado = ctx.empleados.get(id);
    const nombre = this.nombre(ctx, id);
    if (!empleado) {
      return { ok: false as const, bloqueos: [`${nombre}: ya no está en el expediente de empleados.`] };
    }
    // Se pasan las corridas cerradas Y las borradores del trabajador: un borrador del mes lo bloquea.
    const slips: CorridaColilla[] = [];
    for (const run of ctx.corridas) {
      const slip = run.slips.find((s) => s.employeeId === id);
      if (!slip) continue;
      slips.push({
        corridaId: String(run._id),
        periodo: run.period,
        cobertura: run.coverage === 'sede' ? 'sede' : 'all',
        sedeId: run.sedeId ? String(run.sedeId) : undefined,
        estado: run.status === 'cerrada' ? 'cerrada' : 'borrador',
        colilla: {
          employeeId: slip.employeeId,
          employeeName: slip.employeeName,
          diasTrabajados: slip.diasTrabajados,
          salaryType: slip.salaryType,
          breakdown: slip.breakdown,
          otrasDeduccionesDetalle: slip.otrasDeduccionesDetalle,
        },
      });
    }
    const cerradas = ctx.corridas.filter((r) => r.status === 'cerrada').map((r) => r._id);
    const filas = cerradas.length
      ? await this.deducciones.find({ employeeId: id, appliedRunId: { $in: cerradas } }).lean().exec()
      : [];
    const deducciones: DeduccionConsolidar[] = (filas as unknown as DeduccionConsolidar[]).map((f) => ({
      employeeId: f.employeeId,
      concept: f.concept,
      amount: f.amount,
      source: f.source,
      status: f.status,
      appliedRunId: f.appliedRunId ? String(f.appliedRunId) : undefined,
    }));
    const entrada: EntradaConsolidar = {
      periodo: ctx.periodo,
      empleado,
      empleador: { razonSocial: ctx.emisor.razonSocial, municipioDane: ctx.emisor.municipioDane, direccion: ctx.emisor.direccion },
      slips,
      deducciones,
      pago: { fechasPagos: [] },
    };
    const r = consolidarNominaMes(entrada);
    return r.ok ? { ok: true as const, modelo: r.modelo as DocumentoNe, advertencias: r.advertencias } : { ok: false as const, bloqueos: r.bloqueos };
  }

  private emision(ctx: ContextoPeriodo): EmisionNe {
    const { fecha, hora } = relojColombia();
    // Prefijo y consecutivo los pone el servicio de nómina al reservar el número.
    return { fecha, hora, prefijo: '', consecutivo: 1, empleador: ctx.empleador };
  }

  /** 102 vigentes del mes por trabajador (documento de identidad normalizado). */
  private async existentes(ctx: ContextoPeriodo, ids: string[]): Promise<Map<string, PayrollEDocumentDocument>> {
    const porDoc = new Map<string, string>();
    for (const id of ids) {
      const n = (ctx.empleados.get(id)?.docNumber ?? '').replace(/\D/g, '');
      if (n) porDoc.set(n, id);
    }
    const salida = new Map<string, PayrollEDocumentDocument>();
    if (porDoc.size === 0) return salida;
    const filas = await this.docs
      .find({ 'emisor.nitNorm': ctx.emisor.nitNorm, periodo: ctx.periodo, tipoXml: '102', vigente: true, 'empleado.docNumber': { $in: [...porDoc.keys()] } })
      .exec();
    for (const f of filas) {
      const id = porDoc.get(f.empleado?.docNumber ?? '');
      if (id) salida.set(id, f);
    }
    return salida;
  }

  private refExistente(d?: PayrollEDocumentDocument): { documentoExistente?: PrevueloTrabajador['documentoExistente'] } {
    return d ? { documentoExistente: { id: String(d._id), fullNumber: d.fullNumber, dianStatus: d.dianStatus } } : {};
  }

  private deResultado(id: string, nombre: string, r: ResultadoNominaElectronica, adv: string[]): ResultadoTrabajadorEmision {
    const estado: ResultadoTrabajadorEmision['estado'] =
      r.codigo === 'CONFIG_FALTANTE' ? 'error' : r.codigo === 'EN_CURSO' ? 'en_curso' : r.dianStatus === 'accepted' ? 'existente' : 'emitido';
    return {
      empleadoId: id,
      nombre,
      estado: r.dianStatus === 'accepted' && r.transmitido ? 'emitido' : estado,
      documentoId: r.documentoId,
      fullNumber: r.fullNumber,
      dianStatus: r.dianStatus,
      mensajes: [...adv, ...r.mensajes],
    };
  }

  private mensajeError(err: unknown): string {
    const m = (err as { message?: string })?.message;
    return typeof m === 'string' && ((err as { getStatus?: () => number }).getStatus?.() ?? 500) < 500
      ? m.slice(0, 500)
      : 'No se pudo emitir este documento; reintenta.';
  }

  private async auditar(
    action: string,
    user: JwtUser,
    path: string,
    detail: Record<string, string>,
    success = true,
  ): Promise<void> {
    await this.audit.record({
      userId: user.userId,
      userEmail: user.email,
      userName: user.name,
      role: user.role,
      method: 'POST',
      path,
      success,
      action,
      detail,
    });
  }
}
