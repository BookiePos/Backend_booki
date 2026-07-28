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
import { LiquidacionDto } from './dto/liquidacion.dto';
import {
  computeLiquidacion,
  LiquidacionBreakdown,
  LiquidacionInput,
  MotivoRetiro,
} from '../domain/liquidacion-calc';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

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
  ) {}

  async getSettings(): Promise<PayrollSettingsDocument> {
    const doc = await this.settings.findOne().exec();
    if (doc) return doc;
    return this.settings.create({ ...DEFAULT_PAYROLL_SETTINGS });
  }

  private async settingsData(): Promise<PayrollSettingsData> {
    const doc = await this.getSettings();
    return doc.toObject() as unknown as PayrollSettingsData;
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

    const slips: PayrollSlip[] = emps.map((e) => {
      const input: PayrollInput = {
        salarioBase: e.salary ?? 0,
        salaryType: (e.salaryType as SalaryType) ?? 'ordinario',
        diasTrabajados: 30,
        arlRiskLevel: e.arlRiskLevel as ArlLevel | undefined,
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

    return this.runs.create({
      period: dto.period,
      label: dto.label,
      coverage,
      sedeId: dto.sedeId ? new Types.ObjectId(dto.sedeId) : undefined,
      status: 'borrador',
      slips,
      totals,
      createdByEmail: user.email,
    });
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

  async removeRun(id: string): Promise<void> {
    const run = await this.getRun(id);
    await run.deleteOne();
  }
}
