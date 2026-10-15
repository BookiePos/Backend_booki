import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  aplicarReliquidacion,
  contarNoPagado,
  noPagadoCorrida,
  type CorridaLiquidada,
  type NoPagado,
} from './recargos-no-pagados';
import {
  PayrollRun,
  type PayrollRunDocument,
} from '../modules/payroll/infrastructure/schemas/payroll-run.schema';
import {
  AttendanceRecord,
  type AttendanceRecordDocument,
} from '../modules/attendance/infrastructure/schemas/attendance-record.schema';
import { PayrollService } from '../modules/payroll/application/payroll.service';
import { fechaCorteDePeriodo } from '../modules/payroll/domain/payroll-calc';
import { lunesDe } from '../modules/payroll/domain/turnos-classify';

/**
 * Por qué existe (checklist 1.18): hasta octubre de 2026 las corridas reales no
 * pagaban los recargos nocturnos y dominicales ni las horas extra registradas
 * en Turnos (solo el simulador las usaba). Este script SOLO LISTA, por empleado,
 * lo que cada nómina ya liquidada dejó de pagar, con las reglas vigentes en su
 * período (Ley 2466 de 2025: dominical 75/80/90/100 % y noche desde las 7 p.m.
 * a partir del 25-dic-2025; extras contra la jornada semanal vigente).
 * No escribe: `--aplicar` falla a propósito (ver `recargos-no-pagados.ts`).
 *
 *   pnpm build
 *   node dist/datos/2026-10-recargos-no-pagados-informe.js --empresa <id>
 *   node dist/datos/2026-10-recargos-no-pagados-informe.js --todas
 */

async function noPagado(app: INestApplicationContext): Promise<NoPagado[]> {
  const runs = app.get<Model<PayrollRunDocument>>(getModelToken(PayrollRun.name));
  const attendance = app.get<Model<AttendanceRecordDocument>>(
    getModelToken(AttendanceRecord.name),
  );
  const payroll = app.get(PayrollService);

  const lista = await runs
    .find({})
    .select(
      'period status slips.employeeId slips.employeeName slips.salarioBase slips.salaryType ' +
        'slips.arlRiskLevel slips.diasTrabajados slips.breakdown.devengados',
    )
    .sort({ period: 1 })
    .lean()
    .exec();

  const out: NoPagado[] = [];
  for (const r of lista) {
    const run = { ...(r as unknown as CorridaLiquidada), id: String(r._id) };
    const fechaCorte = fechaCorteDePeriodo(run.period);
    // Parámetros (jornada, recargos pactados) vigentes en el período.
    const s = await payroll.parametrosEn(fechaCorte);
    const turnos = await attendance
      .find({
        employeeId: { $in: run.slips.map((c) => c.employeeId) },
        workDate: { $gte: lunesDe(`${run.period}-01`), $lte: fechaCorte },
      })
      .select('employeeId workDate checkIn checkOut')
      .lean()
      .exec();
    for (const f of noPagadoCorrida(run, turnos, s)) {
      console.log(
        `  ${f.period} [${f.status}] ${f.corridaId} · ${f.employeeName ?? f.employeeId}: ` +
          `${f.horas} h, pagado ${f.pagado}, debido ${f.debido}, diferencia ${f.diferencia} COP, ` +
          `IBC adicional ${f.ibcAdicional} COP`,
      );
      out.push(f);
    }
  }
  return out;
}

void enCadaEmpresa({
  nombre: 'informe de recargos y horas extra de Turnos no pagados en nóminas liquidadas (ítem 1.18)',
  contar: async (app) => contarNoPagado(await noPagado(app)),
  aplicar: aplicarReliquidacion,
});
