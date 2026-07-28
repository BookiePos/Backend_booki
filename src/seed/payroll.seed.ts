import { INestApplicationContext, Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmployeesService } from '../modules/employees/application/employees.service';
import { PositionsService } from '../modules/employees/application/positions.service';
import { PayrollService } from '../modules/payroll/application/payroll.service';
import {
  Employee,
  EmployeeDocument,
} from '../modules/employees/infrastructure/schemas/employee.schema';
import {
  Position,
  PositionDocument,
} from '../modules/employees/infrastructure/schemas/position.schema';
import {
  PayrollRun,
  PayrollRunDocument,
} from '../modules/payroll/infrastructure/schemas/payroll-run.schema';
import { JwtUser } from '../modules/core-auth/infrastructure/jwt.strategy';

/** Cargos base del restaurante. */
const CARGOS = ['Administrador', 'Cajero', 'Cocinero', 'Mesero', 'Domiciliario'];

interface EmpSeed {
  docNumber: string;
  firstName: string;
  lastName: string;
  cargo: string;
  salary: number;
  salaryType: 'ordinario' | 'integral';
  arlRiskLevel: 'I' | 'II' | 'III' | 'IV' | 'V';
  gender: 'M' | 'F';
  phone: string;
  eps: string;
  afp: string;
  arl: string;
  bank: string;
  accountNumber: string;
}

/**
 * Roster de empleados con datos completos de seguridad social y banco, para
 * que la corrida de nómina calcule devengados, deducciones, aportes y
 * provisiones de forma realista (Colombia 2026). Incluye los 3 documentos que
 * el seeder de demo usaba, para no duplicarlos.
 */
const EMPLOYEES: EmpSeed[] = [
  { docNumber: '1015447788', firstName: 'Laura', lastName: 'Martínez', cargo: 'Cajero', salary: 1623500, salaryType: 'ordinario', arlRiskLevel: 'I', gender: 'F', phone: '3011111111', eps: 'Sura', afp: 'Porvenir', arl: 'Sura', bank: 'Bancolombia', accountNumber: '10012345601' },
  { docNumber: '1032556677', firstName: 'Diego', lastName: 'Ramírez', cargo: 'Cocinero', salary: 1800000, salaryType: 'ordinario', arlRiskLevel: 'II', gender: 'M', phone: '3022222222', eps: 'Nueva EPS', afp: 'Colfondos', arl: 'Positiva', bank: 'Davivienda', accountNumber: '20012345602' },
  { docNumber: '1045667788', firstName: 'Sofía', lastName: 'Hernández', cargo: 'Mesero', salary: 1623500, salaryType: 'ordinario', arlRiskLevel: 'I', gender: 'F', phone: '3033333333', eps: 'Sanitas', afp: 'Protección', arl: 'Sura', bank: 'Bancolombia', accountNumber: '10012345603' },
  { docNumber: '79880011', firstName: 'Carlos', lastName: 'Gómez', cargo: 'Administrador', salary: 3200000, salaryType: 'ordinario', arlRiskLevel: 'I', gender: 'M', phone: '3044444444', eps: 'Compensar', afp: 'Porvenir', arl: 'Sura', bank: 'Bancolombia', accountNumber: '10012345604' },
  { docNumber: '1090778899', firstName: 'Valentina', lastName: 'López', cargo: 'Cajero', salary: 1623500, salaryType: 'ordinario', arlRiskLevel: 'I', gender: 'F', phone: '3055555555', eps: 'Sura', afp: 'Colpensiones', arl: 'Positiva', bank: 'Nequi', accountNumber: '3055555555' },
  { docNumber: '1122334455', firstName: 'Andrés', lastName: 'Torres', cargo: 'Domiciliario', salary: 1623500, salaryType: 'ordinario', arlRiskLevel: 'IV', gender: 'M', phone: '3066666666', eps: 'Nueva EPS', afp: 'Porvenir', arl: 'Positiva', bank: 'Daviplata', accountNumber: '3066666666' },
];

export interface PayrollSeedResult {
  positions: number;
  employeesCreated: number;
  employeesExisting: number;
  runsCreated: string[];
  runsSkipped: string[];
  lastRunNeto: number;
}

/** Últimos `count` períodos mensuales (YYYY-MM), el más reciente al final. */
export function recentPeriods(count = 3): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Siembra la parte de nómina de forma IDEMPOTENTE: asegura settings del motor,
 * cargos, un roster de empleados (por documento) y una corrida por período
 * (omite las que ya existen). Reutilizable por el seeder de demo y el standalone.
 */
export async function seedPayroll(
  app: INestApplicationContext,
  opts: { sedeId: string; owner: JwtUser; periods?: string[]; logger?: Logger },
): Promise<PayrollSeedResult> {
  const logger = opts.logger ?? new Logger('SeedPayroll');
  const positionsSvc = app.get(PositionsService);
  const employeesSvc = app.get(EmployeesService);
  const payrollSvc = app.get(PayrollService);
  const positionModel = app.get<Model<PositionDocument>>(
    getModelToken(Position.name),
  );
  const employeeModel = app.get<Model<EmployeeDocument>>(
    getModelToken(Employee.name),
  );
  const runModel = app.get<Model<PayrollRunDocument>>(
    getModelToken(PayrollRun.name),
  );

  // 1) Settings del motor de cálculo (siembra los valores CO 2026 por defecto).
  await payrollSvc.getSettings();

  // 2) Cargos (idempotente por nombre).
  for (const name of CARGOS) {
    const exists = await positionModel.exists({ name });
    if (!exists) {
      try {
        await positionsSvc.create({ name });
      } catch {
        /* carrera de duplicado: ignorar */
      }
    }
  }
  const positions = await positionModel.find().exec();
  const posByName = new Map(positions.map((p) => [p.name, String(p._id)]));

  // 3) Empleados (idempotente por documento).
  let employeesCreated = 0;
  let employeesExisting = 0;
  for (const e of EMPLOYEES) {
    if (await employeeModel.exists({ docNumber: e.docNumber })) {
      employeesExisting++;
      continue;
    }
    await employeesSvc.create({
      docType: 'CC',
      docNumber: e.docNumber,
      firstName: e.firstName,
      lastName: e.lastName,
      gender: e.gender,
      phone: e.phone,
      email: `${e.firstName}.${e.lastName}@saborybrasa.co`.toLowerCase(),
      city: 'Bogotá',
      positionId: posByName.get(e.cargo),
      sedeId: opts.sedeId,
      contractType: 'indefinido',
      hireDate: '2026-01-15',
      salary: e.salary,
      salaryType: e.salaryType,
      workSchedule: 'Tiempo completo (48h/sem)',
      eps: e.eps,
      afp: e.afp,
      arl: e.arl,
      arlRiskLevel: e.arlRiskLevel,
      compensationFund: 'Compensar',
      severanceFund: e.afp,
      bank: e.bank,
      accountType: 'ahorros',
      accountNumber: e.accountNumber,
      status: 'activo',
    });
    employeesCreated++;
  }

  // 4) Corridas de nómina por período (idempotente por período + cobertura).
  const periods = opts.periods ?? recentPeriods(3);
  const runsCreated: string[] = [];
  const runsSkipped: string[] = [];
  let lastRunNeto = 0;
  for (const period of periods) {
    const exists = await runModel.exists({ period, coverage: 'all' });
    if (exists) {
      runsSkipped.push(period);
      continue;
    }
    const run = await payrollSvc.createRun(
      { period, coverage: 'all', label: `Nómina ${period}` },
      opts.owner,
    );
    runsCreated.push(period);
    lastRunNeto = run.totals?.neto ?? 0;
  }

  logger.log(
    `Nómina: ${employeesCreated} empleados nuevos (${employeesExisting} ya existían), ` +
      `corridas creadas [${runsCreated.join(', ') || '—'}], omitidas [${runsSkipped.join(', ') || '—'}]`,
  );

  return {
    positions: positions.length,
    employeesCreated,
    employeesExisting,
    runsCreated,
    runsSkipped,
    lastRunNeto,
  };
}
