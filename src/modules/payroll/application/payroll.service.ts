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
import { buildPayslipPdf } from './payslip-pdf';
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
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { cop, sumBy } from '../../finance/domain/money.util';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
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
    Object.assign(doc, dto);
    // Responder la exoneración, en uno u otro sentido, la deja confirmada.
    if (dto.empresaExoneradaAportes !== undefined) doc.exoneracionConfirmada = true;
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
    const filter: Record<string, unknown> = {
      status: 'activo',
      salary: { $gt: 0 },
    };
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

    // Devuelve a "approved" las deducciones que esta corrida había aplicado,
    // para volver a considerarlas (junto con las aprobadas desde entonces).
    await this.deductions
      .updateMany(
        { appliedRunId: run._id },
        { $set: { status: 'approved' }, $unset: { appliedRunId: '', appliedPeriod: '' } },
      )
      .exec();

    const s = await this.parametrosEn(fechaCorteDePeriodo(run.period));
    const filter: Record<string, unknown> = { status: 'activo', salary: { $gt: 0 } };
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
      const registros = recsByEmp.get(e.id) ?? [];
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
        diasTrabajados: Math.min(
          DIAS_MES,
          diasALiquidar(
            new Set(registros.filter((r) => r.checkIn && r.checkOut).map((r) => r.workDate)),
            from,
            to,
            s.diasLaborablesSemana ?? 6,
          ),
        ),
        arlRiskLevel: e.arlRiskLevel as ArlLevel | undefined,
        novedades: Object.keys(novedades).length > 0 ? novedades : undefined,
        fechaCorte: fechaCorteDePeriodo(period),
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
        })),
        totalDevengado: breakdown.devengados.total,
        totalDeducciones: breakdown.deducciones.total,
        netoPagar: breakdown.netoPagar,
        costoEmpleador: breakdown.costoEmpleador,
        alertas: alertasDeTope(turnos.topeExtras),
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

    const input: LiquidacionInput = {
      salarioBase,
      salaryType,
      fechaInicio,
      fechaFin: dto.fechaFin,
      contractType,
      motivo: dto.motivo as MotivoRetiro,
      salariosPendientes: dto.salariosPendientes,
      diasFaltantesContrato: dto.diasFaltantesContrato,
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
    };
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

  /** Cierra una corrida (borrador → cerrada). Queda fija en el historial. */
  async closeRun(id: string, user?: SedeScopeUser): Promise<PayrollRunDocument> {
    const run = await this.getRun(id, user);
    if (run.status === 'cerrada') {
      throw new BadRequestException('La nómina ya está cerrada.');
    }
    // Las colillas descuentan consumos: deben estar marcados `applied` a ESTA
    // corrida. Si `recalcRun` agotó sus reintentos, los soltó a `approved` y
    // dejó las colillas viejas: cerrar así descontaría algo que la próxima
    // corrida volvería a descontar.
    const esperadas = run.slips.flatMap((sl) => sl.otrasDeduccionesDetalle ?? []);
    const aplicadas = await this.deductions
      .find({ appliedRunId: run._id, status: 'applied' })
      .select('amount')
      .exec();
    if (
      aplicadas.length !== esperadas.length ||
      sumBy(aplicadas, (d) => d.amount) !== sumBy(esperadas, (d) => d.amount)
    ) {
      throw new BadRequestException(
        'Los consumos que descuentan las colillas no están amarrados a esta nómina. Recalcúlala antes de cerrarla.',
      );
    }
    run.status = 'cerrada';
    run.closedAt = new Date();
    await run.save();

    // Asiento contable de la nómina causada, con el pasivo separado por
    // concepto (ítem 1.9). Best-effort e idempotente por (payroll_run, runId):
    // igual que el posteo de ventas, un fallo del ledger NO tumba el cierre de
    // la corrida (la corrida es la fuente de verdad y el asiento puede
    // reconstruirse). Las partes salen de las colillas: su suma es el costo del
    // empleador (devengados + aportes + provisiones).
    const ded = (sl: (typeof run.slips)[number]) => sl.breakdown?.deducciones;
    await this.ledgerPosting.postPayrollRun({
      runId: run._id.toString(),
      date: fechaColombia(run.closedAt ?? new Date()),
      sedeId: run.sedeId ? run.sedeId.toString() : undefined,
      period: run.period,
      partes: {
        neto: sumBy(run.slips, (sl) => sl.netoPagar ?? 0),
        seguridadSocialEmpleado: sumBy(
          run.slips,
          (sl) => (ded(sl)?.salud ?? 0) + (ded(sl)?.pension ?? 0) + (ded(sl)?.fsp ?? 0),
        ),
        retencionFuente: sumBy(run.slips, (sl) => ded(sl)?.retencionFuente ?? 0),
        fiado: sumBy(run.slips, (sl) => ded(sl)?.otras ?? 0),
        aportesEmpleador: sumBy(
          run.slips,
          (sl) => sl.breakdown?.aportesEmpleador?.total ?? 0,
        ),
        provisiones: sumBy(run.slips, (sl) => sl.breakdown?.provisiones?.total ?? 0),
      },
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
