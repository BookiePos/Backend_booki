import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PayrollSettings,
  PayrollSettingsDocument,
} from '../infrastructure/schemas/payroll-settings.schema';
import {
  PayrollRun,
  PayrollRunDocument,
  PayrollSlip,
} from '../infrastructure/schemas/payroll-run.schema';
import {
  Employee,
  EmployeeDocument,
} from '../../employees/infrastructure/schemas/employee.schema';
import {
  PayrollDeduction,
  PayrollDeductionDocument,
  DeductionStatus,
} from '../infrastructure/schemas/payroll-deduction.schema';
import {
  AttendanceRecord,
  AttendanceRecordDocument,
} from '../../attendance/infrastructure/schemas/attendance-record.schema';
import {
  Sede,
  SedeDocument,
} from '../../sedes/infrastructure/schemas/sede.schema';
import { MailService } from '../../core-auth/application/mail.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { effectiveEntitlements } from '../../control/domain/plans';
import { PlanUpgradeRequiredException } from '../../control/domain/plan-upgrade.exception';
import { normalizarNit } from '../../einvoicing/domain/consecutivo-unico';
import {
  PayrollEDocument,
  PayrollEDocumentDocument,
} from '../../einvoicing/infrastructure/schemas/payroll-e-document.schema';
import {
  PayrollLiquidacion,
  type PayrollLiquidacionDocument,
} from '../infrastructure/schemas/payroll-liquidacion.schema';
import {
  PayrollNovedad,
  type PayrollNovedadDocument,
} from '../infrastructure/schemas/payroll-novedad.schema';
import {
  liquidarAusencias,
  vacacionesDisfrutadasDeNovedades,
  type NovedadAusencia,
  type TipoNovedad,
} from '../domain/novedades-calc';
import type { CrearNovedadDto } from './dto/novedad.dto';
import { diasPagablesHastaRetiro } from '../domain/liquidacion-calc';
import { buildPayslipPdf, type PayslipNominaElectronica } from './payslip-pdf';
import {
  classifyTurnos,
  lunesDe,
  NovedadesTurnos,
} from '../domain/turnos-classify';
import {
  DEFAULT_PAYROLL_SETTINGS,
  DIAS_MES,
  PayrollSettingsData,
} from '../domain/payroll.constants';
import {
  ArlLevel,
  computeSlip,
  fechaCorteDePeriodo,
  jornadaSemanalVigente,
  PayrollInput,
  type PayrollBreakdown,
  SalaryType,
} from '../domain/payroll-calc';
import { UpdatePayrollSettingsDto } from './dto/update-settings.dto';
import { PreviewPayrollDto } from './dto/preview-payroll.dto';
import { CreateRunDto } from './dto/create-run.dto';
import { CreateDeductionDto } from './dto/deduction.dto';
import { LiquidacionDto } from './dto/liquidacion.dto';
import {
  computeLiquidacion,
  LiquidacionBreakdown,
  LiquidacionInput,
  MotivoRetiro,
} from '../domain/liquidacion-calc';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  allowedSedeIds,
  assertSedeAccess,
  type SedeScopeUser,
} from '../../core-auth/domain/sede-access';
import { ParamsService } from '../../core-params/application/params.service';
import {
  LedgerPostingService,
  lineasNominaCausada,
  type PartesNomina,
} from '../../core-ledger/application/ledger-posting.service';
import { cop, sumBy } from '../../finance/domain/money.util';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { motivoPagoInvalido } from '../domain/pago-nomina';
import { esDuplicadoEn } from '../../core-ledger/domain/journal-entry.indices';
import { INDICE_ARRASTRE_VIVO } from '../domain/payroll-deduction.indices';
import { diasALiquidar } from '../domain/descanso-remunerado';

export interface PreviewResult {
  input: {
    employeeId?: string;
    employeeName?: string;
    salarioBase: number;
    salaryType: SalaryType;
    diasTrabajados: number;
    arlRiskLevel?: ArlLevel;
  };
  breakdown: ReturnType<typeof computeSlip>;
}

/** Respuesta con avisos que no bloquean (el front los muestra). */
type ConAvisos<T> = T & { advertencias: string[] };
function conAvisos<T>(doc: T, advertencias: string[]): ConAvisos<T> {
  const plano = (typeof (doc as { toObject?: () => T }).toObject === 'function'
    ? (doc as unknown as { toObject: () => T }).toObject()
    : doc) as T;
  return { ...plano, advertencias };
}

/** Todas las fechas (YYYY-MM-DD) de los tramos de ausencia. */
function fechasDe(lineas: { fechaInicio: string; fechaFin: string }[]): string[] {
  const out: string[] = [];
  for (const l of lineas) {
    for (let d = l.fechaInicio; d <= l.fechaFin; d = sumarDiasIso(d, 1)) out.push(d);
  }
  return out;
}

/** Una liquidación se guarda cerca del retiro: hasta este margen hacia el futuro (preaviso corto). */
const MARGEN_RETIRO_FUTURO_DIAS = 30;

function sumarDiasIso(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Empleados que entran en la corrida del periodo: los activos con salario y
 * los retirados cuyo retiro cae en el mes. Antes los retirados quedaban
 * fuera y su último sueldo solo aparecía como «salarios pendientes» de la
 * liquidación, sin salud ni pensión (decisión 4 del dueño, tarea 11).
 */
export function filtroNominables(period: string): Record<string, unknown> {
  return {
    salary: { $gt: 0 },
    $or: [
      // Un activo con retiro anterior al periodo ya no se nomina (quedó activo por error).
      { status: 'activo', terminationDate: { $not: { $lt: `${period}-01` } } },
      { status: 'retirado', terminationDate: { $gte: `${period}-01`, $lte: fechaCorteDePeriodo(period) } },
    ],
  };
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    @InjectModel(PayrollSettings.name)
    private readonly settings: Model<PayrollSettingsDocument>,
    @InjectModel(PayrollRun.name)
    private readonly runs: Model<PayrollRunDocument>,
    @InjectModel(Employee.name)
    private readonly employees: Model<EmployeeDocument>,
    @InjectModel(AttendanceRecord.name)
    private readonly attendance: Model<AttendanceRecordDocument>,
    @InjectModel(Sede.name)
    private readonly sedes: Model<SedeDocument>,
    @InjectModel(PayrollDeduction.name)
    private readonly deductions: Model<PayrollDeductionDocument>,
    private readonly mail: MailService,
    private readonly params: ParamsService,
    private readonly ledgerPosting: LedgerPostingService,
    @InjectModel(PayrollEDocument.name)
    private readonly nominaElectronica: Model<PayrollEDocumentDocument>,
    @InjectModel(PayrollLiquidacion.name)
    private readonly liquidaciones: Model<PayrollLiquidacionDocument>,
    @InjectModel(PayrollNovedad.name)
    private readonly novedades: Model<PayrollNovedadDocument>,
  ) {}

  /** Genera el comprobante (PDF) de un desprendible y lo envía al correo del empleado. */
  async sendSlip(
    runId: string,
    employeeId: string,
    user?: SedeScopeUser,
  ): Promise<{
    sent: boolean;
    simulated?: boolean;
    email?: string;
    error?: string;
    id?: string;
  }> {
    const run = await this.getRun(runId, user);
    const slip = run.slips.find((s) => s.employeeId === employeeId);
    if (!slip) {
      throw new NotFoundException('Desprendible no encontrado en esta corrida.');
    }

    const emp = await this.employees.findById(employeeId).exec();
    const email = emp?.email?.trim();
    if (!email) {
      return {
        sent: false,
        error: 'El empleado no tiene correo registrado en su expediente.',
      };
    }

    // Emisor: sede del desprendible si está disponible; si no, encabezado genérico.
    let employerName = 'Empresa';
    let employerNit: string | undefined;
    let employerAddress: string | undefined;
    let employerPhone: string | undefined;
    if (slip.sedeId) {
      const sede = await this.sedes.findById(slip.sedeId).exec();
      if (sede) {
        employerName = sede.businessName || sede.name;
        employerNit = sede.nit;
        employerAddress = sede.address;
        employerPhone = sede.phone;
      }
    }

    const money = new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

    const pdf = await buildPayslipPdf({
      employer: {
        name: employerName,
        nit: employerNit,
        address: employerAddress,
        phone: employerPhone,
      },
      employee: {
        name: slip.employeeName,
        docNumber: slip.docNumber,
        position: slip.positionName,
        salarioBase: slip.salarioBase,
      },
      period: run.period,
      periodLabel: run.label,
      breakdown: slip.breakdown,
      nominaElectronica: await this.nominaAceptada(employeeId, run.period, normalizarNit(employerNit)),
    });

    const slug = (slip.docNumber || employeeId).replace(/[^a-zA-Z0-9]/g, '');
    const filename = `comprobante-nomina-${run.period}-${slug}.pdf`;

    const result = await this.mail.sendPayslip({
      to: email,
      employeeName: slip.employeeName,
      period: run.period,
      netoPagar: money.format(slip.netoPagar),
      employerName,
      pdf,
      filename,
    });

    return { ...result, email };
  }

  /**
   * Consulta acotada: el documento soporte de nómina electrónica aceptado que
   * cuenta hoy para el trabajador, el período y el emisor (NIT de la sede).
   * Excluye lo `superado`, descarta las cadenas con un Eliminar aceptado (aunque
   * su cierre esté pendiente) y prefiere el 103 sobre el 102, desempatando por
   * `_id` descendente. No importa el servicio de nómina electrónica, solo su
   * esquema (modelo por proxy de tenancy).
   */
  private async nominaAceptada(
    employeeId: string,
    periodo: string,
    nitNorm?: string,
  ): Promise<PayslipNominaElectronica | undefined> {
    if (!nitNorm || !Types.ObjectId.isValid(employeeId)) return undefined;
    const docs = await this.nominaElectronica
      .find({
        'empleado.employeeId': new Types.ObjectId(employeeId),
        'emisor.nitNorm': nitNorm,
        periodo,
        tipoXml: { $in: ['102', '103'] },
        dianStatus: 'accepted',
      })
      .select('_id tipoXml tipoNota fullNumber cune superado raizId predecesor')
      .lean()
      .exec();
    const raizDe = (d: (typeof docs)[number]) => String(d.raizId ?? d._id);
    const eliminadas = new Set(
      docs
        .filter((d) => d.tipoXml === '103' && d.tipoNota === 2)
        .map((d) => String(d.raizId ?? d.predecesor?.documentId ?? d._id)),
    );
    const [elegido] = docs
      .filter((d) => d.superado !== true && !(d.tipoXml === '103' && d.tipoNota === 2))
      .filter((d) => !eliminadas.has(raizDe(d)))
      .sort((x, y) =>
        x.tipoXml !== y.tipoXml
          ? x.tipoXml === '103' ? -1 : 1
          : String(y._id).localeCompare(String(x._id)),
      );
    return elegido ? { numero: elegido.fullNumber, cune: elegido.cune } : undefined;
  }

  /** Novedades (horas extra/recargos) sugeridas desde Turnos para un período. */
  async novedadesTurnos(
    employeeId: string,
    from: string,
    to: string,
    user?: SedeScopeUser,
  ): Promise<NovedadesTurnos> {
    if (user) await this.empleadoEnAlcance(employeeId, user);
    const s = await this.parametrosEn(to);
    // Desde el lunes de la semana de `from`: el tope semanal de la jornada se
    // llena también con los días previos de esa semana.
    const recs = await this.attendance
      .find({ employeeId, workDate: { $gte: lunesDe(from), $lte: to } })
      .select('workDate checkIn checkOut')
      .exec();
    return classifyTurnos(
      recs.map((r) => ({
        workDate: r.workDate,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
      })),
      { desde: from, jornadaSemanal: (f) => jornadaSemanalVigente(f, s) },
    );
  }

  async getSettings(): Promise<PayrollSettingsDocument> {
    const doc = await this.settings.findOne().exec();
    if (doc) return doc;
    return this.settings.create({ ...DEFAULT_PAYROLL_SETTINGS });
  }

  /**
   * Parámetros de nómina vigentes en `fecha` (YYYY-MM-DD; por defecto hoy):
   * el expediente con los parámetros compartidos de core-params superpuestos a
   * esa fecha. Público para los informes de `src/datos/`.
   */
  async parametrosEn(fecha?: string): Promise<PayrollSettingsData> {
    const doc = await this.getSettings();
    const data = doc.toObject() as unknown as PayrollSettingsData;
    const opts = fecha ? { date: fecha } : undefined;

    // Parámetros compartidos con el resto del ERP: la fuente de verdad es
    // core-params (SMMLV, auxilio, UVT y recargos se editan en una sola
    // pantalla de Parámetros). Se superponen sobre el expediente de nómina en
    // la fecha del período (son versionados); si un parámetro no está
    // sembrado, se conserva el valor de nómina. Los recargos en params están en
    // % (35) y aquí se usan como factor (0.35).
    data.smmlv = await this.params.number('nomina.salario_minimo', data.smmlv, opts);
    data.auxilioTransporte = await this.params.number(
      'nomina.auxilio_transporte',
      data.auxilioTransporte,
      opts,
    );
    data.uvt = await this.params.number('fiscal.uvt', data.uvt, opts);

    const factor = async (key: string, fallbackFactor: number): Promise<number> =>
      (await this.params.number(key, fallbackFactor * 100, opts)) / 100;
    data.recargos = {
      ...data.recargos,
      recargoNocturno: await factor(
        'recargo.nocturno',
        data.recargos.recargoNocturno,
      ),
      extraDiurna: await factor(
        'recargo.hora_extra_diurna',
        data.recargos.extraDiurna,
      ),
      extraNocturna: await factor(
        'recargo.hora_extra_nocturna',
        data.recargos.extraNocturna,
      ),
    };
    // El dominical legal va por fecha (`recargosVigentes`). De Parámetros solo
    // cuenta una vigencia creada por una persona: es un pacto, y solo rige si
    // supera al legal. La semilla del sistema (90 % desde el 1-ene-2026, sin
    // autor) adelantaba el 90 % que la Ley 2466 fija desde el 1-jul-2026.
    const dominical = await this.params
      .resolve('recargo.dominical_festivo', opts)
      .catch(() => null);
    data.recargoDominicalPactado =
      dominical?.createdByEmail && typeof dominical.value === 'number'
        ? dominical.value / 100
        : undefined;

    return data;
  }

  async updateSettings(
    dto: UpdatePayrollSettingsDto,
  ): Promise<PayrollSettingsDocument> {
    const doc = await this.getSettings();
    const { confirmarExoneracion, ...cambios } = dto;
    Object.assign(doc, cambios);
    // Solo la respuesta explícita a la pregunta (`PreguntaExoneracion`) deja la
    // exoneración confirmada. Que llegue `empresaExoneradaAportes` no basta: el
    // formulario de Ajustes puede mandarlo sin que nadie haya respondido.
    if (confirmarExoneracion === true) {
      if (cambios.empresaExoneradaAportes === undefined) {
        throw new BadRequestException(
          'Para confirmar la exoneración de aportes indica si la empresa está exonerada.',
        );
      }
      doc.exoneracionConfirmada = true;
    }
    await doc.save();
    return doc;
  }

  async preview(
    dto: PreviewPayrollDto,
    user?: SedeScopeUser,
  ): Promise<PreviewResult> {
    if (user && dto.employeeId) await this.empleadoEnAlcance(dto.employeeId, user);
    const s = await this.parametrosEn(
      dto.period ? fechaCorteDePeriodo(dto.period) : undefined,
    );
    let salarioBase = dto.salarioBase ?? 0;
    let salaryType: SalaryType =
      (dto.salaryType as SalaryType) ?? 'ordinario';
    let arlRiskLevel = dto.arlRiskLevel as ArlLevel | undefined;
    let employeeName: string | undefined;

    if (dto.employeeId) {
      const emp = await this.employees.findById(dto.employeeId).exec();
      if (!emp) throw new NotFoundException('Empleado no encontrado');
      if (!emp.salary || emp.salary <= 0) {
        throw new BadRequestException(
          'El empleado no tiene salario registrado en el expediente.',
        );
      }
      salarioBase = emp.salary;
      salaryType = (emp.salaryType as SalaryType) ?? 'ordinario';
      arlRiskLevel = emp.arlRiskLevel as ArlLevel | undefined;
      employeeName = `${emp.firstName} ${emp.lastName}`.trim();
    }

    if (salarioBase <= 0) {
      throw new BadRequestException('Se requiere un salario base mayor a 0.');
    }

    const diasTrabajados = dto.diasTrabajados ?? 30;
    const input: PayrollInput = {
      salarioBase,
      salaryType,
      diasTrabajados,
      arlRiskLevel,
      novedades: dto.novedades,
      fechaCorte: dto.period ? fechaCorteDePeriodo(dto.period) : undefined,
    };
    return {
      input: {
        employeeId: dto.employeeId,
        employeeName,
        salarioBase,
        salaryType,
        diasTrabajados,
        arlRiskLevel,
      },
      breakdown: computeSlip(input, s),
    };
  }

  async createRun(
    dto: CreateRunDto,
    user: JwtUser,
  ): Promise<PayrollRunDocument> {
    // Quien no ve todas las sedes liquida solo la nómina de una de las suyas:
    // la consolidada lleva el salario de toda la empresa (ítem 3.9).
    if (allowedSedeIds(user) !== null) {
      if (dto.coverage !== 'sede' || !dto.sedeId) {
        throw new ForbiddenException(
          'Solo puedes liquidar la nómina de una de tus sedes.',
        );
      }
      assertSedeAccess(user, dto.sedeId);
    }
    const s = await this.parametrosEn(fechaCorteDePeriodo(dto.period));
    // La exoneración de aportes no se presume (ítem 1.15): sin respuesta
    // explícita no se liquida, porque de ella depende si se pagan salud, SENA
    // e ICBF del empleador.
    if (!s.exoneracionConfirmada) {
      throw new BadRequestException(
        'Antes de liquidar la nómina indica en Ajustes si la empresa está exonerada de aportes (art. 114-1 ET).',
      );
    }
    const coverage = dto.coverage ?? 'all';
    const filter: Record<string, unknown> = filtroNominables(dto.period);
    if (coverage === 'sede') {
      if (!dto.sedeId) {
        throw new BadRequestException('Indica la sede para la cobertura "sede".');
      }
      filter.sedeId = new Types.ObjectId(dto.sedeId);
    }

    // Evita corridas duplicadas del mismo período+cobertura(+sede): dos corridas
    // del mismo período causan doble conteo en el P&L y doble aplicación de
    // deducciones. Si ya existe una, se rechaza; para re-correr hay que eliminar
    // (o dejar en borrador y usar recalcRun) la anterior. Un índice único a
    // nivel de BD respalda esta garantía ante concurrencia.
    const dupFilter: Record<string, unknown> = { period: dto.period, coverage };
    dupFilter.sedeId =
      coverage === 'sede' && dto.sedeId
        ? new Types.ObjectId(dto.sedeId)
        : null;
    const existing = await this.runs.findOne(dupFilter).exec();
    if (existing) {
      throw new ConflictException(
        `Ya existe una corrida de nómina para el período ${dto.period} (${coverage}). Elimínala o recalcúlala en borrador antes de crear otra.`,
      );
    }

    const emps = await this.employees
      .find(filter)
      .sort({ lastName: 1, firstName: 1 })
      .exec();
    if (emps.length === 0) {
      throw new BadRequestException(
        'No hay empleados activos con salario para nominar en esta cobertura.',
      );
    }

    // Tope de empleados por plan (Control 10 / Cadena 25 + complemento de
    // empleados adicionales). La feature payroll ya la exige el controller; aquí
    // limitamos el tamaño de la corrida. Fail-open si no hay plan en contexto.
    const ctx = TenantContext.current();
    if (ctx?.plan) {
      const { quotas } = effectiveEntitlements(ctx.plan, ctx.addOns);
      if (
        quotas.payrollEmployees > 0 &&
        emps.length > quotas.payrollEmployees
      ) {
        throw new PlanUpgradeRequiredException(
          `Tu plan cubre nómina para ${quotas.payrollEmployees} empleado(s) y esta corrida tiene ${emps.length}. Agrega empleados adicionales o mejora tu plan.`,
          { reason: 'quota', quota: 'payrollEmployees' },
        );
      }
    }

    const { slips, totals, approvedIds } = await this.buildRunSlips(
      emps,
      s,
      dto.period,
    );

    const run = await this.runs.create({
      period: dto.period,
      label: dto.label,
      coverage,
      // `null` explícito (no undefined) para cobertura 'all': el índice único
      // (period, coverage, sedeId) trata las corridas consolidadas de forma
      // consistente y evita duplicados a nivel de BD.
      sedeId: (coverage === 'sede' && dto.sedeId
        ? new Types.ObjectId(dto.sedeId)
        : null) as unknown as Types.ObjectId | undefined,
      status: 'borrador',
      slips,
      totals,
      createdByEmail: user.email,
    });

    try {
      await this.applyDeductionsToRun(approvedIds, run._id, dto.period);
    } catch (err) {
      // Las colillas descuentan algo que no quedó amarrado a la corrida: la
      // corrida no se deja a medias.
      await this.runs.deleteOne({ _id: run._id }).exec();
      throw err;
    }
    return run;
  }

  /**
   * Recalcula una corrida en **borrador**: vuelve a leer los consumos aprobados
   * y las horas, y actualiza colillas y totales. Sirve cuando se aprobó un
   * consumo (u otro cambio) después de haber generado la corrida. Las corridas
   * cerradas no se pueden recalcular.
   */
  async recalcRun(id: string, user: JwtUser): Promise<PayrollRunDocument> {
    const run = Types.ObjectId.isValid(id)
      ? await this.runs.findById(id).exec()
      : null;
    if (!run || !this.corridaEnAlcance(run, user)) {
      throw new NotFoundException('Corrida no encontrada');
    }
    if (run.status !== 'borrador') {
      throw new BadRequestException(
        'Solo se puede recalcular una corrida en borrador.',
      );
    }

    // Si un cierre fallido alcanzó a dejar arrastres de esta corrida, ya no
    // valen: las colillas van a cambiar. El próximo cierre los vuelve a crear.
    await this.anularArrastresDe(run);

    // Devuelve a "approved" las deducciones que esta corrida había aplicado,
    // para volver a considerarlas (junto con las aprobadas desde entonces).
    await this.deductions
      .updateMany(
        { appliedRunId: run._id },
        { $set: { status: 'approved' }, $unset: { appliedRunId: '', appliedPeriod: '' } },
      )
      .exec();

    const s = await this.parametrosEn(fechaCorteDePeriodo(run.period));
    const filter: Record<string, unknown> = filtroNominables(run.period);
    if (run.coverage === 'sede' && run.sedeId) {
      filter.sedeId = run.sedeId;
    }
    const emps = await this.employees
      .find(filter)
      .sort({ lastName: 1, firstName: 1 })
      .exec();

    // Se aplica ANTES de guardar las colillas: si un consumo cambió entre la
    // lectura y la aplicación (se anuló o lo tomó otra corrida), se vuelve a
    // calcular con lo que hay ahora en vez de guardar colillas que no cuadran.
    for (let intento = 1; ; intento++) {
      const { slips, totals, approvedIds } = await this.buildRunSlips(
        emps,
        s,
        run.period,
      );
      try {
        await this.applyDeductionsToRun(approvedIds, run._id, run.period);
      } catch (err) {
        if (err instanceof ConflictException && intento < 3) continue;
        throw err;
      }
      run.slips = slips;
      run.totals = totals;
      await run.save();
      return run;
    }
  }

  /**
   * Construye las colillas y totales de una corrida a partir de los empleados y
   * los parámetros, incorporando los consumos aprobados como "otras
   * deducciones". Devuelve también los ids de esos consumos para marcarlos como
   * aplicados. Reutilizado por crear y recalcular.
   */
  private async buildRunSlips(
    emps: EmployeeDocument[],
    s: PayrollSettingsData,
    period: string,
  ): Promise<{
    slips: PayrollSlip[];
    totals: {
      devengado: number;
      deducciones: number;
      neto: number;
      aportes: number;
      provisiones: number;
      costo: number;
    };
    approvedIds: Types.ObjectId[];
  }> {
    const approved = await this.deductions
      .find({ employeeId: { $in: emps.map((e) => e.id) }, status: 'approved' })
      .exec();
    const dedByEmp = new Map<string, PayrollDeductionDocument[]>();
    for (const d of approved) {
      const arr = dedByEmp.get(d.employeeId) ?? [];
      arr.push(d);
      dedByEmp.set(d.employeeId, arr);
    }

    // Días trabajados y horas por empleado, tomados de Turnos (asistencia) del
    // período. El salario se prorratea por estos días (X/30). Estricto: sin
    // registros de horas ⇒ 0 días ⇒ no se paga ese mes (lo alimenta el control
    // de horas). Las horas clasificadas (recargos nocturnos y dominicales,
    // extras) se pagan en la colilla: antes solo las veía el simulador. Se lee
    // desde el lunes de la semana del día 1 para que el tope semanal de la
    // jornada cuente los días de esa semana que cayeron en el mes anterior.
    const from = `${period}-01`;
    const to = fechaCorteDePeriodo(period);
    const recs = await this.attendance
      .find({
        employeeId: { $in: emps.map((e) => e.id) },
        workDate: { $gte: lunesDe(from), $lte: to },
      })
      .select('employeeId workDate checkIn checkOut')
      .exec();
    // Vacaciones, incapacidades y licencias activas que tocan el mes (decisión 3 del dueño).
    const novs = await this.novedades
      .find({ employeeId: { $in: emps.map((e) => e.id) }, estado: 'activa', fechaInicio: { $lte: to }, fechaFin: { $gte: from } })
      .exec();
    const novsByEmp = new Map<string, NovedadAusencia[]>();
    for (const n of novs) {
      const arr = novsByEmp.get(n.employeeId) ?? [];
      arr.push({ id: String(n._id), tipo: n.tipo, fechaInicio: n.fechaInicio, fechaFin: n.fechaFin, diasPreviosProrroga: n.diasPreviosProrroga, diasHabiles: n.diasHabiles });
      novsByEmp.set(n.employeeId, arr);
    }
    const recsByEmp = new Map<
      string,
      { workDate: string; checkIn?: string; checkOut?: string }[]
    >();
    for (const r of recs) {
      const arr = recsByEmp.get(r.employeeId) ?? [];
      arr.push({ workDate: r.workDate, checkIn: r.checkIn, checkOut: r.checkOut });
      recsByEmp.set(r.employeeId, arr);
    }

    const slips: PayrollSlip[] = emps.map((e) => {
      const empDeductions = dedByEmp.get(e.id) ?? [];
      const otrasDeducciones = empDeductions.reduce((sum, d) => sum + d.amount, 0);
      // Quien se retira en el mes se liquida hasta el día del retiro, con su
      // salud, pensión y retención como cualquier colilla (decisión 4 del
      // dueño): ni turnos ni descansos remunerados después de esa fecha.
      const hasta = e.terminationDate && e.terminationDate >= from && e.terminationDate < to ? e.terminationDate : to;
      // Ausencias del mes: sus días salen de los trabajados (un turno marcado en
      // vacaciones o incapacidad no se paga dos veces) y se pagan por su regla.
      const novsEmp = (novsByEmp.get(e.id) ?? []).map((n) => ({ ...n, fechaFin: n.fechaFin < hasta ? n.fechaFin : hasta }));
      const ausencias = liquidarAusencias(novsEmp.filter((n) => n.fechaInicio <= n.fechaFin), period, e.salary ?? 0, s.smmlv);
      const enAusencia = (d: string) => ausencias.lineas.some((l) => d >= l.fechaInicio && d <= l.fechaFin);
      const registros = (recsByEmp.get(e.id) ?? []).filter((r) => r.workDate <= hasta && !enAusencia(r.workDate));
      const turnos = classifyTurnos(registros, {
        desde: from,
        jornadaSemanal: (f) => jornadaSemanalVigente(f, s),
      });
      // Al salario integral no se le liquidan recargos ni extras: ya los
      // compensa (art. 132 num. 2 CST). El expediente no registra un pacto en
      // contrario, así que no hay excepción que leer.
      const integral = e.salaryType === 'integral';
      const conHoras = !integral && Object.values(turnos.horas).some((h) => h > 0);
      const novedades = {
        ...(conHoras ? { horas: turnos.horas } : {}),
        ...(otrasDeducciones > 0 ? { otrasDeducciones } : {}),
      };
      const input: PayrollInput = {
        salarioBase: e.salary ?? 0,
        salaryType: (e.salaryType as SalaryType) ?? 'ordinario',
        // Días con turno + descansos remunerados que ganó (domingos y días no
        // laborables de semanas completas, festivos), sobre el mes comercial
        // de 30 días: el mes completo paga 30 aunque tenga 28 o 31 (ítem 1.19).
        // Basta la entrada: olvidar la salida no quita el día ni el descanso de
        // la semana; solo deja sin horas extra ni recargos (classifyTurnos), y
        // la colilla lo avisa.
        // Los días de ausencia cuentan como presentes para ganar el descanso de
        // la semana (una ausencia justificada no lo hace perder, art. 173 CST) y
        // luego se restan: se pagan por su propia regla.
        diasTrabajados: Math.max(
          0,
          Math.min(
            DIAS_MES,
            diasALiquidar(
              new Set([...registros.filter((r) => r.checkIn).map((r) => r.workDate), ...fechasDe(ausencias.lineas)]),
              from,
              hasta,
              s.diasLaborablesSemana ?? 6,
            ),
          ) - ausencias.diasRemunerados - ausencias.diasNoRemunerados,
        ),
        arlRiskLevel: e.arlRiskLevel as ArlLevel | undefined,
        novedades: Object.keys(novedades).length > 0 ? novedades : undefined,
        fechaCorte: fechaCorteDePeriodo(period),
        ...(ausencias.lineas.length > 0 ? { ausencias } : {}),
      };
      const breakdown = computeSlip(input, s);
      return {
        employeeId: e.id,
        employeeName: `${e.firstName} ${e.lastName}`.trim(),
        docNumber: e.docNumber,
        positionName: e.positionName,
        sedeId: e.sedeId,
        salarioBase: input.salarioBase,
        salaryType: input.salaryType,
        arlRiskLevel: input.arlRiskLevel,
        diasTrabajados: input.diasTrabajados,
        breakdown,
        otrasDeduccionesDetalle: empDeductions.map((d) => ({
          concept: d.concept,
          amount: d.amount,
          ...(d.source === 'arrastre' ? { source: d.source } : {}),
        })),
        totalDevengado: breakdown.devengados.total,
        totalDeducciones: breakdown.deducciones.total,
        netoPagar: breakdown.netoPagar,
        costoEmpleador: breakdown.costoEmpleador,
        alertas: [...alertasDeTope(turnos.topeExtras), ...alertasSinSalida(registros, from)],
      };
    });

    // Señal (no cambia la política estricta): empleados que quedaron con 0 días
    // trabajados por falta de registros de asistencia se liquidan en 0. Sin este
    // aviso el pago en 0 pasa inadvertido; con él queda visible en el log.
    const sinDias = slips.filter((sl) => sl.diasTrabajados === 0);
    if (sinDias.length > 0) {
      this.logger.warn(
        `Nómina ${period}: ${sinDias.length} empleado(s) con 0 días trabajados (sin asistencia) ` +
          `se liquidan en 0: ${sinDias.map((sl) => sl.employeeName || sl.employeeId).join(', ')}.`,
      );
    }

    const totals = slips.reduce(
      (acc, sl) => ({
        devengado: acc.devengado + sl.totalDevengado,
        deducciones: acc.deducciones + sl.totalDeducciones,
        neto: acc.neto + sl.netoPagar,
        aportes: acc.aportes + sl.breakdown.aportesEmpleador.total,
        provisiones: acc.provisiones + sl.breakdown.provisiones.total,
        costo: acc.costo + sl.costoEmpleador,
      }),
      { devengado: 0, deducciones: 0, neto: 0, aportes: 0, provisiones: 0, costo: 0 },
    );

    return { slips, totals, approvedIds: approved.map((d) => d._id) };
  }

  /**
   * Marca como "applied" los consumos que entraron en una corrida. El update es
   * CONDICIONAL sobre `status: 'approved'` (transición approved→applied), así
   * es la fuente de verdad: si dos corridas concurrentes intentan aplicar la
   * misma deducción, solo la primera la transiciona; la segunda no la vuelve a
   * aplicar (matchedCount = 0), evitando el doble descuento.
   */
  private async applyDeductionsToRun(
    ids: Types.ObjectId[],
    runId: Types.ObjectId,
    period: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const res = await this.deductions
      .updateMany(
        { _id: { $in: ids }, status: 'approved' },
        { $set: { status: 'applied', appliedRunId: runId, appliedPeriod: period } },
      )
      .exec();
    // Alguna dejó de estar aprobada entre la lectura y aquí (se anuló con su
    // venta o la tomó otra corrida), pero las colillas sí la descuentan. Se
    // sueltan las que tomó esta corrida y quien llama decide (borrar o
    // recalcular).
    if (res.matchedCount !== ids.length) {
      await this.deductions
        .updateMany(
          { appliedRunId: runId },
          {
            $set: { status: 'approved' },
            $unset: { appliedRunId: '', appliedPeriod: '' },
          },
        )
        .exec();
      throw new ConflictException(
        'Un consumo de nómina cambió mientras se generaba la corrida (se anuló o lo tomó otra corrida). Vuelve a generarla.',
      );
    }
  }

  // ── Deducciones de empleado (consumos, descuentos) ──────────────────────────

  /**
   * Verifica, sin crear nada, que el empleado existe y está activo. Ventas lo
   * llama ANTES de vender para no dejar una venta fiada sin deducción.
   */
  async assertEmpleadoParaConsumo(employeeId: string): Promise<void> {
    const emp = await this.employees.findById(employeeId).select('status').exec();
    if (!emp || emp.status !== 'activo') {
      throw new BadRequestException('El empleado seleccionado no existe o no está activo');
    }
  }

  /** Crea una deducción; nace 'pending' (requiere aprobación para descontarse). */
  async createDeduction(
    dto: CreateDeductionDto,
    user: JwtUser,
    opts: { sinAlcanceDeSede?: boolean } = {},
  ): Promise<PayrollDeductionDocument> {
    const emp = await this.employees.findById(dto.employeeId).exec();
    // `sinAlcanceDeSede` es solo para el consumo POS (ventas): el empleado
    // consumió en esta sede aunque sea de otra o no tenga sede. El endpoint
    // HTTP sí aplica el alcance de sede del usuario.
    if (!emp || (!opts.sinAlcanceDeSede && !this.sedeEnAlcance(user, emp.sedeId))) {
      throw new NotFoundException('Empleado no encontrado');
    }
    return this.deductions.create({
      employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
      docNumber: emp.docNumber,
      sedeId: emp.sedeId,
      concept: dto.concept,
      amount: cop(dto.amount),
      date: dto.date ?? new Date().toLocaleDateString('en-CA'),
      status: 'pending',
      source: dto.source ?? 'manual',
      sourceId: dto.sourceId,
      note: dto.note,
      createdByEmail: user.email,
    });
  }

  /**
   * Cancela el consumo POS de una venta a crédito que se anula. Mientras está
   * pendiente o aprobado no ha salido de ninguna colilla y basta con cambiarle
   * el estado. Si ya se aplicó en una corrida, se rechaza ANTES de tocar nada:
   * el descuento ya está en la colilla (y, si la nómina se cerró, en el libro),
   * y devolverlo es un ajuste de nómina, no un cambio de estado.
   */
  async cancelSaleDeduction(saleId: string): Promise<void> {
    const aplicada = await this.deductions
      .findOne({ source: 'sale', sourceId: saleId, status: 'applied' })
      .exec();
    if (aplicada) {
      throw new BadRequestException(
        `El consumo de esta venta ya se descontó en la nómina ${aplicada.appliedPeriod ?? ''}`.trim() +
          '. Si esa nómina sigue en borrador, elimínala, anula la venta y vuelve a generarla; si está cerrada, la venta no se puede anular: devuélvele el valor al empleado con un ajuste en la próxima nómina.',
      );
    }
    await this.deductions
      .updateMany(
        {
          source: 'sale',
          sourceId: saleId,
          status: { $in: ['pending', 'approved'] },
        },
        { $set: { status: 'cancelled' } },
      )
      .exec();
    // Una corrida pudo aplicarlo entre la revisión y el updateMany: entonces no
    // se canceló nada y el consumo ya está en una colilla.
    const tomada = await this.deductions
      .findOne({ source: 'sale', sourceId: saleId, status: 'applied' })
      .exec();
    if (tomada) {
      throw new BadRequestException(
        `El consumo de esta venta acaba de entrar en la nómina ${tomada.appliedPeriod ?? ''}`.trim() +
          '. Si esa nómina sigue en borrador, elimínala, anula la venta y vuelve a generarla.',
      );
    }
  }

  /**
   * Deshace cancelSaleDeduction cuando la anulación de la venta se aborta más
   * adelante. Vuelve a 'pending' (no a 'approved'): no se sabe si estaba
   * aprobada y es más seguro pedir aprobarla otra vez que descontar sin
   * aprobación. Solo las ventas cancelan consumos, así que no se resucita
   * nada que alguien haya anulado a mano.
   */
  async restoreSaleDeduction(saleId: string): Promise<void> {
    await this.deductions
      .updateMany(
        { source: 'sale', sourceId: saleId, status: 'cancelled' },
        { $set: { status: 'pending' } },
      )
      .exec();
  }

  async listDeductions(
    query: {
      employeeId?: string;
      status?: DeductionStatus;
    },
    user?: SedeScopeUser,
  ): Promise<PayrollDeductionDocument[]> {
    const filter: Record<string, unknown> = {};
    const sedes = user ? allowedSedeIds(user) : null;
    if (sedes) filter.sedeId = { $in: sedes.map((id) => new Types.ObjectId(id)) };
    if (query.employeeId) filter.employeeId = query.employeeId;
    if (query.status) filter.status = query.status;
    return this.deductions.find(filter).sort({ createdAt: -1 }).exec();
  }

  private async deductionOrFail(
    id: string,
    user?: SedeScopeUser,
  ): Promise<PayrollDeductionDocument> {
    const d = await this.deductions.findById(id).exec();
    if (!d || (user && !this.sedeEnAlcance(user, d.sedeId))) {
      throw new NotFoundException('Deducción no encontrada');
    }
    return d;
  }

  /** Aprueba una deducción pendiente (entrará en la próxima corrida). */
  async approveDeduction(
    id: string,
    user: JwtUser,
  ): Promise<PayrollDeductionDocument> {
    const d = await this.deductionOrFail(id, user);
    if (d.status !== 'pending') {
      throw new BadRequestException(
        `Solo se aprueban deducciones pendientes (estado actual: ${d.status}).`,
      );
    }
    d.status = 'approved';
    d.approvedByEmail = user.email;
    await d.save();
    return d;
  }

  /** Rechaza una deducción pendiente (no se descuenta). */
  async rejectDeduction(
    id: string,
    user: JwtUser,
  ): Promise<PayrollDeductionDocument> {
    const d = await this.deductionOrFail(id, user);
    if (d.status !== 'pending') {
      throw new BadRequestException(
        `Solo se rechazan deducciones pendientes (estado actual: ${d.status}).`,
      );
    }
    d.status = 'rejected';
    d.approvedByEmail = user.email;
    d.note = d.note ?? undefined;
    await d.save();
    return d;
  }

  async liquidacion(
    dto: LiquidacionDto,
    user?: SedeScopeUser,
  ): Promise<{
    input: {
      employeeId?: string;
      employeeName?: string;
      salarioBase: number;
      salaryType: SalaryType;
      contractType?: string;
      fechaInicio: string;
      fechaFin: string;
      motivo: string;
    };
    breakdown: LiquidacionBreakdown;
    advertencias: string[];
    /** Días de vacaciones disfrutados según las novedades registradas, para precargar el dato. */
    sugerencias?: { vacacionesDisfrutadasDias: number };
  }> {
    if (user && dto.employeeId) await this.empleadoEnAlcance(dto.employeeId, user);
    const s = await this.parametrosEn(dto.fechaFin);
    let salarioBase = dto.salarioBase ?? 0;
    let salaryType: SalaryType = (dto.salaryType as SalaryType) ?? 'ordinario';
    let contractType = dto.contractType;
    let fechaInicio = dto.fechaInicio;
    let employeeName: string | undefined;

    if (dto.employeeId) {
      const emp = await this.employees.findById(dto.employeeId).exec();
      if (!emp) throw new NotFoundException('Empleado no encontrado');
      if (!emp.salary || emp.salary <= 0) {
        throw new BadRequestException(
          'El empleado no tiene salario registrado en el expediente.',
        );
      }
      salarioBase = emp.salary;
      salaryType = (emp.salaryType as SalaryType) ?? 'ordinario';
      contractType = contractType ?? emp.contractType;
      fechaInicio = fechaInicio ?? emp.hireDate;
      employeeName = `${emp.firstName} ${emp.lastName}`.trim();
    }

    if (salarioBase <= 0) {
      throw new BadRequestException('Se requiere un salario base mayor a 0.');
    }
    if (!fechaInicio) {
      throw new BadRequestException(
        'Falta la fecha de inicio (o el expediente sin fecha de ingreso).',
      );
    }
    if (fechaInicio > dto.fechaFin) {
      throw new BadRequestException(
        'La fecha de inicio no puede ser posterior a la de retiro.',
      );
    }
    if (dto.inicioCesantias && (dto.inicioCesantias < fechaInicio || dto.inicioCesantias > dto.fechaFin)) {
      throw new BadRequestException(
        'El inicio de las cesantías debe estar entre la fecha de ingreso y la de retiro.',
      );
    }

    const input: LiquidacionInput = {
      salarioBase,
      salaryType,
      fechaInicio,
      fechaFin: dto.fechaFin,
      contractType,
      motivo: dto.motivo as MotivoRetiro,
      salariosPendientes: dto.salariosPendientes,
      diasFaltantesContrato: dto.diasFaltantesContrato,
      inicioCesantias: dto.inicioCesantias,
      vacacionesDisfrutadasDias: dto.vacacionesDisfrutadasDias,
    };
    return {
      input: {
        employeeId: dto.employeeId,
        employeeName,
        salarioBase,
        salaryType,
        contractType,
        fechaInicio,
        fechaFin: dto.fechaFin,
        motivo: dto.motivo,
      },
      breakdown: computeLiquidacion(input, s),
      advertencias: dto.employeeId ? await this.avisoVariables(dto.employeeId, dto.fechaFin) : [],
      ...(dto.employeeId ? await this.sugerenciaVacaciones(dto.employeeId, fechaInicio, dto.fechaFin) : {}),
    };
  }

  /**
   * Suma los días hábiles de las vacaciones registradas como novedad entre el
   * ingreso y el retiro. Es una sugerencia: las disfrutadas antes de usar
   * BookiPos no están registradas.
   */
  private async sugerenciaVacaciones(
    employeeId: string,
    desde: string,
    hasta: string,
  ): Promise<{ sugerencias?: { vacacionesDisfrutadasDias: number } }> {
    const vac = await this.novedades
      .find({ employeeId, estado: 'activa', tipo: 'vacaciones', fechaInicio: { $gte: desde, $lte: hasta } })
      .exec();
    if (vac.length === 0) return {};
    return {
      sugerencias: {
        vacacionesDisfrutadasDias: vacacionesDisfrutadasDeNovedades(
          vac.map((n) => ({ tipo: n.tipo, fechaInicio: n.fechaInicio, fechaFin: n.fechaFin, diasHabiles: n.diasHabiles })),
        ),
      },
    };
  }

  // ─── Novedades: vacaciones, incapacidades y licencias (decisión 3) ────────

  /** Meses (YYYY-MM) que toca un rango de fechas. */
  private mesesDe(desde: string, hasta: string): string[] {
    const meses: string[] = [];
    let y = Number(desde.slice(0, 4));
    let m = Number(desde.slice(5, 7));
    const fin = hasta.slice(0, 7);
    for (;;) {
      const p = `${y}-${String(m).padStart(2, '0')}`;
      meses.push(p);
      if (p >= fin || meses.length > 24) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return meses;
  }

  /** Una corrida CERRADA ya liquidó al empleado en alguno de esos meses: la novedad no se puede tocar. */
  private async assertMesesAbiertos(employeeId: string, desde: string, hasta: string): Promise<void> {
    const cerrada = await this.runs
      .findOne({ period: { $in: this.mesesDe(desde, hasta) }, status: 'cerrada', 'slips.employeeId': employeeId })
      .select('period')
      .exec();
    if (cerrada) {
      throw new ConflictException(
        `La nómina de ${cerrada.period} ya está cerrada con este empleado: la novedad cambiaría lo que ya se pagó. Regístrala como ajuste con el contador.`,
      );
    }
  }

  /**
   * Registra una novedad. Valida fechas, que no se cruce con otra activa del
   * mismo empleado y que la nómina de esos meses siga abierta (una corrida en
   * borrador se recalcula para tomarla).
   */
  async crearNovedad(dto: CrearNovedadDto, user: SedeScopeUser & { email?: string }): Promise<PayrollNovedadDocument> {
    await this.empleadoEnAlcance(dto.employeeId, user);
    const valida = (f: string) => {
      const d = new Date(`${f}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
    };
    if (!valida(dto.fechaInicio) || !valida(dto.fechaFin)) throw new BadRequestException('Las fechas de la novedad no son válidas.');
    if (dto.fechaFin < dto.fechaInicio) throw new BadRequestException('La fecha final no puede ser anterior a la inicial.');
    if (this.mesesDe(dto.fechaInicio, dto.fechaFin).length > 12) {
      throw new BadRequestException('Una novedad no puede pasar de 12 meses; regístrala por tramos (prórrogas).');
    }
    const tipo = dto.tipo as TipoNovedad;
    if (tipo === 'vacaciones' && !dto.diasHabiles) {
      throw new BadRequestException('Indica los días hábiles de vacaciones que disfruta (los descuenta la liquidación de retiro).');
    }
    if (dto.diasPreviosProrroga !== undefined && tipo !== 'incapacidad_comun') {
      throw new BadRequestException('Los días previos de prórroga solo aplican a la incapacidad común.');
    }
    const cruce = await this.novedades
      .findOne({ employeeId: dto.employeeId, estado: 'activa', fechaInicio: { $lte: dto.fechaFin }, fechaFin: { $gte: dto.fechaInicio } })
      .exec();
    if (cruce) {
      throw new ConflictException(`Se cruza con otra novedad (${cruce.tipo} del ${cruce.fechaInicio} al ${cruce.fechaFin}). Anúlala o ajusta las fechas.`);
    }
    await this.assertMesesAbiertos(dto.employeeId, dto.fechaInicio, dto.fechaFin);
    const emp = await this.employees.findById(dto.employeeId).select('sedeId firstName lastName').exec();
    return this.novedades.create({
      employeeId: dto.employeeId,
      employeeName: emp ? `${emp.firstName} ${emp.lastName}`.trim() : undefined,
      sedeId: emp?.sedeId,
      tipo,
      fechaInicio: dto.fechaInicio,
      fechaFin: dto.fechaFin,
      ...(dto.diasPreviosProrroga !== undefined ? { diasPreviosProrroga: dto.diasPreviosProrroga } : {}),
      ...(tipo === 'vacaciones' ? { diasHabiles: dto.diasHabiles } : {}),
      observacion: dto.observacion,
      estado: 'activa',
      creadaPor: user.email,
    });
  }

  /** Lista por empleado y/o periodo, solo de empleados de las sedes del usuario (su sede actual). */
  async listarNovedades(
    filtros: { employeeId?: string; periodo?: string },
    user?: SedeScopeUser,
  ): Promise<PayrollNovedadDocument[]> {
    const filtro: Record<string, unknown> = {};
    if (filtros.employeeId) filtro.employeeId = filtros.employeeId;
    if (filtros.periodo) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filtros.periodo)) throw new BadRequestException('periodo debe ser YYYY-MM');
      filtro.fechaInicio = { $lte: fechaCorteDePeriodo(filtros.periodo) };
      filtro.fechaFin = { $gte: `${filtros.periodo}-01` };
    }
    const sedes = user ? allowedSedeIds(user) : null;
    if (sedes) {
      const visibles = await this.employees
        .find({ sedeId: { $in: sedes.map((id) => new Types.ObjectId(id)) } })
        .select('_id')
        .exec();
      const ids = visibles.map((e) => String(e._id));
      filtro.employeeId = filtros.employeeId ? (ids.includes(filtros.employeeId) ? filtros.employeeId : { $in: [] }) : { $in: ids };
    }
    return this.novedades.find(filtro).sort({ fechaInicio: -1 }).limit(200).exec();
  }

  /** Anula una novedad (atómico). No se puede si la nómina de esos meses ya se cerró con el empleado. */
  async anularNovedad(id: string, user?: SedeScopeUser & { email?: string }): Promise<PayrollNovedadDocument> {
    const nov = Types.ObjectId.isValid(id) ? await this.novedades.findById(id).exec() : null;
    if (!nov) throw new NotFoundException('Novedad no encontrada');
    if (user) await this.empleadoEnAlcance(nov.employeeId, user);
    await this.assertMesesAbiertos(nov.employeeId, nov.fechaInicio, nov.fechaFin);
    const anulada = await this.novedades
      .findOneAndUpdate(
        { _id: nov._id, estado: 'activa' },
        { $set: { estado: 'anulada', anuladaPor: user?.email, anuladaEn: new Date() } },
        { new: true },
      )
      .exec();
    if (!anulada) throw new ConflictException('La novedad ya está anulada.');
    return anulada;
  }

  /**
   * Art. 253 CST: con salario variable, las prestaciones se liquidan con el
   * promedio de lo devengado. BookiPos aún usa el salario fijo; se avisa si en
   * las corridas cerradas de los últimos 3 meses hubo horas extra, recargos,
   * comisiones o bonificaciones salariales.
   */
  private async avisoVariables(employeeId: string, fechaFin: string): Promise<string[]> {
    const y = Number(fechaFin.slice(0, 4));
    const m = Number(fechaFin.slice(5, 7));
    const meses = [0, 1, 2].map((i) => new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
    const corridas = await this.runs
      .find({ period: { $in: meses }, status: 'cerrada', 'slips.employeeId': employeeId })
      .select('slips.employeeId slips.breakdown')
      .lean()
      .exec();
    const variable = (corridas as unknown as { slips: { employeeId: string; breakdown?: PayrollBreakdown }[] }[])
      .flatMap((r) => r.slips)
      .filter((sl) => sl.employeeId === employeeId)
      .reduce((t, sl) => {
        const d = sl.breakdown?.devengados;
        return t + (d ? (d.recargos ?? 0) + (d.horasExtra ?? 0) + (d.comisiones ?? 0) + (d.bonificacionSalarial ?? 0) : 0);
      }, 0);
    return variable > 0
      ? [
          `En los últimos 3 meses tuvo devengos variables (${variable}: horas extra, recargos, comisiones o bonificaciones). Por el art. 253 CST las prestaciones se liquidan con el salario PROMEDIO, y este cálculo usa el salario fijo: revísalo con el contador.`,
        ]
      : [];
  }

  listRuns(user?: SedeScopeUser): Promise<PayrollRunDocument[]> {
    const sedes = user ? allowedSedeIds(user) : null;
    const filter = sedes
      ? {
          coverage: 'sede',
          sedeId: { $in: sedes.map((id) => new Types.ObjectId(id)) },
        }
      : {};
    return this.runs
      .find(filter)
      .select('-slips')
      .sort({ createdAt: -1 })
      .limit(60)
      .exec();
  }

  async getRun(id: string, user?: SedeScopeUser): Promise<PayrollRunDocument> {
    const run = Types.ObjectId.isValid(id)
      ? await this.runs.findById(id).exec()
      : null;
    if (!run || (user && !this.corridaEnAlcance(run, user))) {
      throw new NotFoundException('Corrida de nómina no encontrada');
    }
    return run;
  }

  // ─── Alcance por sede (ítem 3.9) ──────────────────────────────────────────
  // Sin `user` (llamadas internas) no se filtra. Lo de otra sede da 404, igual
  // que si no existiera. Lo que no tiene sede es de la empresa y solo lo ve
  // quien la ve entera.

  private sedeEnAlcance(user: SedeScopeUser, sedeId?: Types.ObjectId): boolean {
    const sedes = allowedSedeIds(user);
    return sedes === null || (!!sedeId && sedes.includes(sedeId.toString()));
  }

  /** La consolidada (`all`) solo la ve quien ve todas las sedes. */
  private corridaEnAlcance(run: PayrollRunDocument, user: SedeScopeUser): boolean {
    if (allowedSedeIds(user) === null) return true;
    return run.coverage === 'sede' && this.sedeEnAlcance(user, run.sedeId);
  }

  private async empleadoEnAlcance(employeeId: string, user: SedeScopeUser): Promise<void> {
    if (allowedSedeIds(user) === null) return;
    const emp = Types.ObjectId.isValid(employeeId)
      ? await this.employees.findById(employeeId).select('sedeId').exec()
      : null;
    if (!emp || !this.sedeEnAlcance(user, emp.sedeId)) {
      throw new NotFoundException('Empleado no encontrado');
    }
  }

  // ─── Liquidación de retiro guardada y aprobada (decisión 4 del dueño) ─────

  /**
   * Calcula y GUARDA la liquidación de un empleado como borrador. El último
   * sueldo no entra aquí: se liquida en la corrida del mes del retiro (con
   * salud, pensión y retención), así que «salarios pendientes» se rechaza.
   */
  async guardarLiquidacion(
    dto: LiquidacionDto,
    user: SedeScopeUser & { email?: string },
  ): Promise<PayrollLiquidacionDocument> {
    if (!dto.employeeId || !Types.ObjectId.isValid(dto.employeeId)) {
      throw new BadRequestException('Para guardar la liquidación elige un empleado válido.');
    }
    const limite = sumarDiasIso(fechaColombia(new Date()), MARGEN_RETIRO_FUTURO_DIAS);
    if (dto.fechaFin > limite) {
      throw new BadRequestException(
        `La fecha de retiro (${dto.fechaFin}) está a más de ${MARGEN_RETIRO_FUTURO_DIAS} días: guarda la liquidación cerca del retiro.`,
      );
    }
    if ((dto.salariosPendientes ?? 0) > 0) {
      throw new BadRequestException(
        'El último sueldo no va como «salarios pendientes»: se paga en la nómina del mes del retiro, con salud y pensión. Déjalo en 0 y corre (o recalcula) esa nómina.',
      );
    }
    const { input, breakdown } = await this.liquidacion(dto, user);
    const emp = await this.employees.findById(dto.employeeId).select('sedeId').exec();
    return this.liquidaciones.create({
      employeeId: dto.employeeId,
      employeeName: input.employeeName,
      sedeId: emp?.sedeId,
      fechaInicio: input.fechaInicio,
      fechaRetiro: input.fechaFin,
      motivo: input.motivo,
      contractType: input.contractType,
      salarioBase: input.salarioBase,
      salaryType: input.salaryType,
      breakdown,
      estado: 'borrador',
      creadaPor: user.email,
    });
  }

  /** Lista por la sede ACTUAL del empleado (igual que aprobar y anular), no por la que tenía al guardarla. */
  async listarLiquidaciones(employeeId: string | undefined, user?: SedeScopeUser): Promise<PayrollLiquidacionDocument[]> {
    const filtro: Record<string, unknown> = {};
    if (employeeId) filtro.employeeId = employeeId;
    const sedes = user ? allowedSedeIds(user) : null;
    if (sedes) {
      const visibles = await this.employees
        .find({ sedeId: { $in: sedes.map((id) => new Types.ObjectId(id)) } })
        .select('_id')
        .exec();
      const ids = visibles.map((e) => String(e._id));
      filtro.employeeId = employeeId ? (ids.includes(employeeId) ? employeeId : { $in: [] }) : { $in: ids };
    }
    return this.liquidaciones.find(filtro).sort({ createdAt: -1 }).limit(100).exec();
  }

  private async liquidacionEnAlcance(id: string, user?: SedeScopeUser): Promise<PayrollLiquidacionDocument> {
    const liq = Types.ObjectId.isValid(id) ? await this.liquidaciones.findById(id).exec() : null;
    if (!liq) throw new NotFoundException('Liquidación no encontrada');
    if (user) await this.empleadoEnAlcance(liq.employeeId, user);
    return liq;
  }

  /** Deja el retiro en el expediente: fecha y estado `retirado` (idempotente). */
  private async marcarRetiro(liq: { employeeId: string; fechaRetiro: string }): Promise<void> {
    await this.employees
      .updateOne(
        { _id: new Types.ObjectId(liq.employeeId) },
        { $set: { terminationDate: liq.fechaRetiro, status: 'retirado' } },
      )
      .exec();
  }

  /**
   * Aprueba un borrador con el medio y la fecha real del pago. Queda fija: es
   * la que la nómina electrónica del mes del retiro reporta (cesantías,
   * intereses, prima, vacaciones compensadas e indemnización). Deja el retiro
   * en el expediente. Atómico: solo pasa de `borrador` a `aprobada` una vez;
   * si ya estaba aprobada, solo reaplica el retiro (idempotente).
   */
  async aprobarLiquidacion(
    id: string,
    pago: { medioPago: string; fechaPago: string },
    user?: SedeScopeUser & { email?: string },
  ): Promise<ConAvisos<PayrollLiquidacion>> {
    const liq = await this.liquidacionEnAlcance(id, user);
    if (liq.estado === 'aprobada') {
      await this.marcarRetiro(liq);
      const distinto = liq.pago && (liq.pago.medio !== pago.medioPago || liq.pago.fecha !== pago.fechaPago);
      return conAvisos(liq, [
        ...(distinto
          ? [
              `La liquidación ya estaba aprobada con pago ${liq.pago!.medio} del ${liq.pago!.fecha}: se ignoraron el medio y la fecha enviados. Para cambiarlos, anúlala y guarda y aprueba una nueva.`,
            ]
          : []),
        ...(await this.avisoCorridaCerrada(liq)),
      ]);
    }
    if (liq.estado !== 'borrador') {
      throw new BadRequestException(`La liquidación está ${liq.estado}; solo se aprueba un borrador.`);
    }
    if (liq.breakdown?.vacacionesDisfrutadasDias === undefined) {
      throw new BadRequestException(
        'Falta cuántos días de vacaciones ya disfrutó el empleado: vuelve a guardar la liquidación con ese dato (0 si no disfrutó ninguno).',
      );
    }
    const motivo = motivoPagoInvalido(liq.fechaRetiro.slice(0, 7), pago.medioPago, pago.fechaPago, fechaColombia(new Date()));
    if (motivo) throw new BadRequestException(motivo);
    let aprobada: PayrollLiquidacionDocument | null;
    try {
      aprobada = await this.liquidaciones
        .findOneAndUpdate(
          { _id: liq._id, estado: 'borrador' },
          {
            $set: {
              estado: 'aprobada',
              pago: { medio: pago.medioPago, fecha: pago.fechaPago },
              aprobadaPor: user?.email,
              aprobadaEn: new Date(),
            },
          },
          { new: true },
        )
        .exec();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictException('El empleado ya tiene una liquidación aprobada. Anúlala antes de aprobar otra.');
      }
      throw err;
    }
    if (!aprobada) {
      throw new ConflictException('La liquidación cambió mientras la aprobabas (otra persona la aprobó o la anuló). Vuelve a cargarla.');
    }
    await this.marcarRetiro(aprobada);
    return conAvisos(aprobada, await this.avisoCorridaCerrada(aprobada));
  }

  /**
   * Aviso (no bloquea) si una corrida CERRADA del mes del retiro ya le pagó más
   * días de los que van hasta el retiro: misma comparación que el bloqueo del
   * consolidador (`diasPagablesHastaRetiro`). La corrida cerrada no se
   * recalcula; el pago de más se registra con el contador.
   */
  private async avisoCorridaCerrada(liq: { employeeId: string; fechaRetiro: string }): Promise<string[]> {
    const periodo = liq.fechaRetiro.slice(0, 7);
    const corridas = await this.runs
      .find({ period: periodo, status: 'cerrada', 'slips.employeeId': liq.employeeId })
      .select('slips.employeeId slips.diasTrabajados')
      .lean()
      .exec();
    const dias = (corridas as unknown as { slips: { employeeId: string; diasTrabajados: number }[] }[])
      .flatMap((r) => r.slips)
      .filter((sl) => sl.employeeId === liq.employeeId)
      .reduce((t, sl) => t + (sl.diasTrabajados ?? 0), 0);
    if (dias === 0) return [];
    const emp = await this.employees.findById(liq.employeeId).select('hireDate').exec();
    const tope = diasPagablesHastaRetiro(emp?.hireDate, liq.fechaRetiro);
    if (dias <= tope) return [];
    return [
      `La nómina de ${periodo} ya se cerró y le paga ${dias} días; hasta el retiro (${liq.fechaRetiro}) van ${tope}. La nómina electrónica de ese mes queda bloqueada: registra con el contador el pago de más (${dias - tope} días) como una deducción o un ajuste del empleado. Para la próxima, aprueba la liquidación antes de cerrar la corrida del mes.`,
    ];
  }

  /**
   * Anula una liquidación (borrador o aprobada), atómico. Si ya salió en una
   * nómina electrónica aceptada, el documento se corrige con la nota de ajuste.
   * NO deshace el retiro que dejó la aprobación (fecha y estado `retirado` en el
   * expediente): anular suele ser para corregir cifras, no porque el empleado
   * no se haya ido. Se avisa; si el retiro fue un error, se edita el expediente.
   */
  async anularLiquidacion(
    id: string,
    user?: SedeScopeUser & { email?: string },
  ): Promise<ConAvisos<PayrollLiquidacion>> {
    const liq = await this.liquidacionEnAlcance(id, user);
    const anulada = await this.liquidaciones
      .findOneAndUpdate(
        { _id: liq._id, estado: { $ne: 'anulada' } },
        { $set: { estado: 'anulada', anuladaPor: user?.email, anuladaEn: new Date() } },
        { new: true },
      )
      .exec();
    if (!anulada) throw new ConflictException('La liquidación ya está anulada.');
    return conAvisos(
      anulada,
      liq.estado === 'aprobada'
        ? ['El empleado sigue como retirado en el expediente (fecha y estado). Si el retiro fue un error, edítalo en el expediente.']
        : [],
    );
  }

  /**
   * Medio y fecha real del pago de la corrida (decisión 1 del dueño): se
   * declaran al cerrar o después, sobre una corrida cerrada. La nómina
   * electrónica del mes no se consolida sin ellos. Si ya hay documento
   * aceptado, cambiarlos exige corregirlo con la nota de ajuste (Reemplazar).
   */
  private validarPago(run: PayrollRunDocument, medio: string, fecha: string): void {
    const motivo = motivoPagoInvalido(run.period, medio, fecha, fechaColombia(new Date()));
    if (motivo) throw new BadRequestException(motivo);
  }

  async declararPago(
    id: string,
    pago: { medioPago: string; fechaPago: string },
    user?: SedeScopeUser & { email?: string },
  ): Promise<PayrollRunDocument> {
    const run = await this.getRun(id, user);
    if (run.status !== 'cerrada') {
      throw new BadRequestException('El pago se declara sobre una nómina cerrada; ciérrala primero (o decláralo al cerrarla).');
    }
    this.validarPago(run, pago.medioPago, pago.fechaPago);
    run.pago = { medio: pago.medioPago, fecha: pago.fechaPago, declaradoPor: user?.email, declaradoEn: new Date() };
    await run.save();
    return run;
  }

  /** Cierra una corrida (borrador → cerrada). Queda fija en el historial. */
  async closeRun(
    id: string,
    user?: SedeScopeUser & { email?: string },
    pago?: { medioPago?: string; fechaPago?: string },
  ): Promise<PayrollRunDocument> {
    const run = await this.getRun(id, user);
    if (run.status === 'cerrada') {
      throw new BadRequestException('La nómina ya está cerrada.');
    }
    if (pago && (pago.medioPago || pago.fechaPago)) {
      if (!pago.medioPago || !pago.fechaPago) {
        throw new BadRequestException('Declara el medio Y la fecha real del pago, o ninguno de los dos.');
      }
      this.validarPago(run, pago.medioPago, pago.fechaPago);
    }
    // Las colillas descuentan consumos: deben estar marcados `applied` a ESTA
    // corrida. Si `recalcRun` agotó sus reintentos, los soltó a `approved` y
    // dejó las colillas viejas: cerrar así descontaría algo que la próxima
    // corrida volvería a descontar.
    const esperadas = run.slips.flatMap((sl) => sl.otrasDeduccionesDetalle ?? []);
    const aplicadas = await this.deductions
      .find({ appliedRunId: run._id, status: 'applied' })
      .select('amount source')
      .exec();
    if (
      aplicadas.length !== esperadas.length ||
      sumBy(aplicadas, (d) => d.amount) !== sumBy(esperadas, (d) => d.amount)
    ) {
      throw new BadRequestException(
        'Los consumos que descuentan las colillas no están amarrados a esta nómina. Recalcúlala antes de cerrarla.',
      );
    }

    // Asiento contable de la nómina causada, con el pasivo separado por
    // concepto (ítem 1.9). Las partes salen de las colillas: su suma es el
    // costo del empleador (devengados + aportes + provisiones). De las "otras
    // deducciones", solo el fiado del POS (`source: 'sale'`) cancela la 1305
    // que abrió la venta; las manuales (libranzas, embargos) son un pasivo con
    // un tercero. El neto negativo de una colilla no se paga: queda a cargo del
    // empleado (1365) y se arrastra a la nómina siguiente; el arrastre que esta
    // corrida descuenta de la anterior (`source: 'arrastre'`) cancela esa 1365.
    const ded = (sl: (typeof run.slips)[number]) => sl.breakdown?.deducciones;
    const fiado = sumBy(
      aplicadas.filter((d) => d.source === 'sale'),
      (d) => d.amount,
    );
    const arrastre = sumBy(
      aplicadas.filter((d) => d.source === 'arrastre'),
      (d) => d.amount,
    );
    const partes: PartesNomina = {
      neto: sumBy(run.slips, (sl) => Math.max(0, sl.netoPagar ?? 0)),
      saldoACargoEmpleados: sumBy(run.slips, (sl) => Math.max(0, -(sl.netoPagar ?? 0))),
      seguridadSocialEmpleado: sumBy(
        run.slips,
        (sl) => (ded(sl)?.salud ?? 0) + (ded(sl)?.pension ?? 0) + (ded(sl)?.fsp ?? 0),
      ),
      retencionFuente: sumBy(run.slips, (sl) => ded(sl)?.retencionFuente ?? 0),
      fiado,
      arrastre,
      otrasDeducciones: sumBy(run.slips, (sl) => ded(sl)?.otras ?? 0) - fiado - arrastre,
      aportesEmpleador: sumBy(
        run.slips,
        (sl) => sl.breakdown?.aportesEmpleador?.total ?? 0,
      ),
      provisiones: sumBy(run.slips, (sl) => sl.breakdown?.provisiones?.total ?? 0),
    };
    // Se valida ANTES de cerrar: si las partes no dan un asiento cuadrado, la
    // corrida sigue en borrador en vez de cerrarse sin asiento.
    try {
      lineasNominaCausada(partes);
    } catch (err) {
      throw new BadRequestException(
        `No se puede cerrar la nómina: ${(err as Error).message}`,
      );
    }

    // El saldo a cargo se arrastra ANTES de marcarla cerrada: si esto falla, la
    // corrida sigue en borrador y se puede volver a cerrar (es idempotente).
    await this.crearArrastres(run);

    run.status = 'cerrada';
    run.closedAt = new Date();
    if (pago?.medioPago && pago.fechaPago) {
      run.pago = { medio: pago.medioPago, fecha: pago.fechaPago, declaradoPor: user?.email, declaradoEn: run.closedAt };
    }
    await run.save();

    // Best-effort e idempotente por (payroll_run, runId): igual que el posteo
    // de ventas, un fallo del ledger NO tumba el cierre de la corrida (la
    // corrida es la fuente de verdad y el asiento puede reconstruirse).
    await this.ledgerPosting.postPayrollRun({
      runId: run._id.toString(),
      date: fechaColombia(run.closedAt ?? new Date()),
      sedeId: run.sedeId ? run.sedeId.toString() : undefined,
      period: run.period,
      partes,
      userEmail: run.createdByEmail,
    });

    return run;
  }

  async removeRun(id: string, user?: SedeScopeUser): Promise<void> {
    const run = await this.getRun(id, user);
    if (run.status === 'cerrada') {
      throw new BadRequestException(
        'No se puede eliminar una nómina cerrada. Es el comprobante del período.',
      );
    }
    await this.anularArrastresDe(run);
    // Devuelve las deducciones aplicadas a 'approved' para poder re-nominarlas.
    await this.deductions
      .updateMany(
        { appliedRunId: run._id },
        {
          $set: { status: 'approved' },
          $unset: { appliedRunId: '', appliedPeriod: '' },
        },
      )
      .exec();
    await run.deleteOne();
  }

  // ── Arrastre del saldo a cargo del empleado (ítem 1.9) ─────────────────────
  // Una colilla con neto negativo no se paga: el saldo queda en la 1365. Sin
  // esto nadie lo cobraba; el cierre lo convierte en una deducción aprobada
  // para la nómina siguiente, que al aplicarse cancela la 1365.

  /**
   * Crea (o deja como estaba) una deducción `arrastre` por cada colilla con
   * neto negativo. Idempotente por (corrida, empleado): cerrar dos veces o
   * reintentar un cierre fallido no la duplica, y el índice único
   * `arrastre_vivo_unico` lo garantiza ante dos cierres simultáneos: el que
   * pierde recibe E11000 y lo toma como «ya existe». No se aplica el tope del
   * art. 149 CST: la nómina no lo aplica a ninguna deducción hoy.
   */
  private async crearArrastres(run: PayrollRunDocument): Promise<void> {
    const runId = run._id.toString();
    const siguiente = periodoSiguiente(run.period);
    for (const sl of run.slips) {
      const saldo = cop(-(sl.netoPagar ?? 0));
      if (saldo <= 0) continue;
      try {
        await this.deductions
          .updateOne(
            // Los anulados ya no tienen `sourceId` (ver anularArrastresDe).
            { source: 'arrastre', sourceId: runId, employeeId: sl.employeeId },
            {
              $setOnInsert: {
                employeeName: sl.employeeName,
                docNumber: sl.docNumber,
                sedeId: sl.sedeId,
                concept: `Saldo a cargo de nómina ${run.period}`,
                amount: saldo,
                date: `${siguiente}-01`,
                status: 'approved',
                note: `Neto negativo de la nómina ${run.period}; se descuenta en la siguiente.`,
                createdByEmail: run.createdByEmail,
              },
            },
            { upsert: true },
          )
          .exec();
      } catch (err) {
        if (!esDuplicadoEn(err, INDICE_ARRASTRE_VIVO)) throw err;
      }
    }
  }

  /**
   * Anula los arrastres que creó el cierre de esta corrida. Se llama al borrar
   * o recalcular una corrida en borrador (un cierre que falló después de
   * crearlos) y es el gancho para cuando una corrida cerrada se reabra. Si una
   * nómina siguiente ya lo descontó, no se anula a escondidas: hay que borrar
   * o recalcular esa primero.
   */
  async anularArrastresDe(run: PayrollRunDocument): Promise<void> {
    const runId = run._id.toString();
    const aplicado = await this.deductions
      .findOne({ source: 'arrastre', sourceId: runId, status: 'applied' })
      .exec();
    if (aplicado) {
      throw new BadRequestException(
        `El saldo a cargo de ${aplicado.employeeName} de esta nómina ya se descontó en la nómina ${aplicado.appliedPeriod ?? ''}`.trim() +
          '. Elimina o recalcula esa nómina primero.',
      );
    }
    await this.deductions
      .updateMany(
        {
          source: 'arrastre',
          sourceId: runId,
          status: { $in: ['pending', 'approved'] },
        },
        // Sale del índice único: un nuevo cierre puede crear el vigente.
        { $set: { status: 'cancelled' }, $rename: { sourceId: 'sourceIdAnulado' } },
      )
      .exec();
  }
}

/** Período siguiente a `YYYY-MM`. */
function periodoSiguiente(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Aviso de turnos del período con entrada y sin salida (ítem 1.19). */
function alertasSinSalida(
  registros: Array<{ workDate: string; checkIn?: unknown; checkOut?: unknown }>,
  desde: string,
): string[] {
  // Solo los del período: los de la semana anterior al día 1 sirven para saber
  // si la semana está completa, pero ese día no se liquida en esta colilla.
  const n = registros.filter((r) => r.workDate >= desde && r.checkIn && !r.checkOut).length;
  return n > 0
    ? [`${n} turno(s) sin salida: el día se paga, pero sin horas extra ni recargos. Corrige la asistencia antes de cerrar.`]
    : [];
}

/**
 * Avisos del tope de horas extra (Ley 2466 de 2025, art. 13: máximo 2 h al día
 * y 12 h a la semana). Las horas se pagan igual; el aviso es para corregir la
 * programación de turnos (ítem 1.19).
 */
function alertasDeTope(t: { diasSobre2h: number; semanasSobre12h: number }): string[] {
  const alertas: string[] = [];
  if (t.diasSobre2h > 0) {
    alertas.push(
      `Más de 2 horas extra en ${t.diasSobre2h} ${t.diasSobre2h === 1 ? 'día' : 'días'} (tope legal, Ley 2466 de 2025, art. 13).`,
    );
  }
  if (t.semanasSobre12h > 0) {
    alertas.push(
      `Más de 12 horas extra en ${t.semanasSobre12h} ${t.semanasSobre12h === 1 ? 'semana' : 'semanas'} (tope legal, Ley 2466 de 2025, art. 13).`,
    );
  }
  return alertas;
}
