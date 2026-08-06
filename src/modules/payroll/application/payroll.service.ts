import {
  BadRequestException,
  Injectable,
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
import { buildPayslipPdf } from './payslip-pdf';
import {
  classifyTurnos,
  NovedadesTurnos,
} from '../domain/turnos-classify';
import {
  DEFAULT_PAYROLL_SETTINGS,
  PayrollSettingsData,
} from '../domain/payroll.constants';
import {
  ArlLevel,
  computeSlip,
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
import { ParamsService } from '../../core-params/application/params.service';

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
  ) {}

  /** Genera el comprobante (PDF) de un desprendible y lo envía al correo del empleado. */
  async sendSlip(
    runId: string,
    employeeId: string,
  ): Promise<{
    sent: boolean;
    simulated?: boolean;
    email?: string;
    error?: string;
    id?: string;
  }> {
    const run = await this.getRun(runId);
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
  ): Promise<NovedadesTurnos> {
    const recs = await this.attendance
      .find({ employeeId, workDate: { $gte: from, $lte: to } })
      .select('workDate checkIn checkOut')
      .exec();
    return classifyTurnos(
      recs.map((r) => ({
        workDate: r.workDate,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
      })),
    );
  }

  async getSettings(): Promise<PayrollSettingsDocument> {
    const doc = await this.settings.findOne().exec();
    if (doc) return doc;
    return this.settings.create({ ...DEFAULT_PAYROLL_SETTINGS });
  }

  private async settingsData(): Promise<PayrollSettingsData> {
    const doc = await this.getSettings();
    const data = doc.toObject() as unknown as PayrollSettingsData;

    // Parámetros compartidos con el resto del ERP: la fuente de verdad es
    // core-params (SMMLV, auxilio, UVT y recargos se editan en una sola
    // pantalla de Parámetros). Se superponen sobre el expediente de nómina;
    // si un parámetro no está sembrado, se conserva el valor de nómina. Los
    // recargos en params están en % (35) y aquí se usan como factor (0.35).
    data.smmlv = await this.params.number('nomina.salario_minimo', data.smmlv);
    data.auxilioTransporte = await this.params.number(
      'nomina.auxilio_transporte',
      data.auxilioTransporte,
    );
    data.uvt = await this.params.number('fiscal.uvt', data.uvt);

    const factor = async (key: string, fallbackFactor: number): Promise<number> =>
      (await this.params.number(key, fallbackFactor * 100)) / 100;
    data.recargos = {
      ...data.recargos,
      recargoNocturno: await factor(
        'recargo.nocturno',
        data.recargos.recargoNocturno,
      ),
      dominical: await factor(
        'recargo.dominical_festivo',
        data.recargos.dominical,
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

    return data;
  }

  async updateSettings(
    dto: UpdatePayrollSettingsDto,
  ): Promise<PayrollSettingsDocument> {
    const doc = await this.getSettings();
    Object.assign(doc, dto);
    await doc.save();
    return doc;
  }

  async preview(dto: PreviewPayrollDto): Promise<PreviewResult> {
    const s = await this.settingsData();
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
    const s = await this.settingsData();
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

    const emps = await this.employees
      .find(filter)
      .sort({ lastName: 1, firstName: 1 })
      .exec();
    if (emps.length === 0) {
      throw new BadRequestException(
        'No hay empleados activos con salario para nominar en esta cobertura.',
      );
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
      sedeId: dto.sedeId ? new Types.ObjectId(dto.sedeId) : undefined,
      status: 'borrador',
      slips,
      totals,
      createdByEmail: user.email,
    });

    await this.applyDeductionsToRun(approvedIds, run._id, dto.period);
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
    if (!run) throw new NotFoundException('Corrida no encontrada');
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

    const s = await this.settingsData();
    const filter: Record<string, unknown> = { status: 'activo', salary: { $gt: 0 } };
    if (run.coverage === 'sede' && run.sedeId) {
      filter.sedeId = run.sedeId;
    }
    const emps = await this.employees
      .find(filter)
      .sort({ lastName: 1, firstName: 1 })
      .exec();

    const { slips, totals, approvedIds } = await this.buildRunSlips(
      emps,
      s,
      run.period,
    );
    run.slips = slips;
    run.totals = totals;
    await run.save();

    await this.applyDeductionsToRun(approvedIds, run._id, run.period);
    return run;
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

    // Días trabajados por empleado, tomados de Turnos (asistencia) del período.
    // El salario se prorratea por estos días (X/30). Estricto: sin registros de
    // horas ⇒ 0 días ⇒ no se paga ese mes (lo alimenta el control de horas).
    const y = Number(period.slice(0, 4));
    const mo = Number(period.slice(5, 7));
    const from = `${period}-01`;
    const lastDay = new Date(y, mo, 0).getDate();
    const to = `${period}-${String(lastDay).padStart(2, '0')}`;
    const recs = await this.attendance
      .find({
        employeeId: { $in: emps.map((e) => e.id) },
        workDate: { $gte: from, $lte: to },
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
      const diasTrabajados = classifyTurnos(
        recsByEmp.get(e.id) ?? [],
      ).diasTrabajados;
      const input: PayrollInput = {
        salarioBase: e.salary ?? 0,
        salaryType: (e.salaryType as SalaryType) ?? 'ordinario',
        diasTrabajados,
        arlRiskLevel: e.arlRiskLevel as ArlLevel | undefined,
        novedades: otrasDeducciones > 0 ? { otrasDeducciones } : undefined,
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
      };
    });

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

  /** Marca los consumos que entraron en una corrida como "applied". */
  private async applyDeductionsToRun(
    ids: Types.ObjectId[],
    runId: Types.ObjectId,
    period: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.deductions
      .updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'applied', appliedRunId: runId, appliedPeriod: period } },
      )
      .exec();
  }

  // ── Deducciones de empleado (consumos, descuentos) ──────────────────────────

  /** Crea una deducción; nace 'pending' (requiere aprobación para descontarse). */
  async createDeduction(
    dto: CreateDeductionDto,
    user: JwtUser,
  ): Promise<PayrollDeductionDocument> {
    const emp = await this.employees.findById(dto.employeeId).exec();
    if (!emp) throw new NotFoundException('Empleado no encontrado');
    return this.deductions.create({
      employeeId: emp.id,
      employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
      docNumber: emp.docNumber,
      sedeId: emp.sedeId,
      concept: dto.concept,
      amount: Math.round(dto.amount),
      date: dto.date ?? new Date().toLocaleDateString('en-CA'),
      status: 'pending',
      source: dto.source ?? 'manual',
      sourceId: dto.sourceId,
      note: dto.note,
      createdByEmail: user.email,
    });
  }

  async listDeductions(query: {
    employeeId?: string;
    status?: DeductionStatus;
  }): Promise<PayrollDeductionDocument[]> {
    const filter: Record<string, unknown> = {};
    if (query.employeeId) filter.employeeId = query.employeeId;
    if (query.status) filter.status = query.status;
    return this.deductions.find(filter).sort({ createdAt: -1 }).exec();
  }

  private async deductionOrFail(
    id: string,
  ): Promise<PayrollDeductionDocument> {
    const d = await this.deductions.findById(id).exec();
    if (!d) throw new NotFoundException('Deducción no encontrada');
    return d;
  }

  /** Aprueba una deducción pendiente (entrará en la próxima corrida). */
  async approveDeduction(
    id: string,
    user: JwtUser,
  ): Promise<PayrollDeductionDocument> {
    const d = await this.deductionOrFail(id);
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
    const d = await this.deductionOrFail(id);
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

  async liquidacion(dto: LiquidacionDto): Promise<{
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
    const s = await this.settingsData();
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

  listRuns(): Promise<PayrollRunDocument[]> {
    return this.runs
      .find()
      .select('-slips')
      .sort({ createdAt: -1 })
      .limit(60)
      .exec();
  }

  async getRun(id: string): Promise<PayrollRunDocument> {
    const run = Types.ObjectId.isValid(id)
      ? await this.runs.findById(id).exec()
      : null;
    if (!run) throw new NotFoundException('Corrida de nómina no encontrada');
    return run;
  }

  /** Cierra una corrida (borrador → cerrada). Queda fija en el historial. */
  async closeRun(id: string): Promise<PayrollRunDocument> {
    const run = await this.getRun(id);
    if (run.status === 'cerrada') {
      throw new BadRequestException('La nómina ya está cerrada.');
    }
    run.status = 'cerrada';
    run.closedAt = new Date();
    await run.save();
    return run;
  }

  async removeRun(id: string): Promise<void> {
    const run = await this.getRun(id);
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
