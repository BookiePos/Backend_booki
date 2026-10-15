import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { enCadaEmpresa } from './en-cada-empresa';
import { contarDivisor, diferenciaCorrida, type CorridaGuardada } from './divisor-nomina';
import {
  PayrollRun,
  type PayrollRunDocument,
} from '../modules/payroll/infrastructure/schemas/payroll-run.schema';
import {
  PayrollSettings,
  type PayrollSettingsDocument,
} from '../modules/payroll/infrastructure/schemas/payroll-settings.schema';
import {
  DEFAULT_PAYROLL_SETTINGS,
  type PayrollSettingsData,
} from '../modules/payroll/domain/payroll.constants';

/**
 * Por qué existe (checklist 1.8): hasta octubre de 2026 la hora ordinaria se
 * dividía por 240 h fijas; con la Ley 2101 de 2021 el divisor baja con la
 * jornada (235, 230, 220 y 210 h). Este script SOLO LISTA las corridas ya
 * liquidadas con otro divisor y cuánto difieren sus recargos y horas extra.
 * No escribe: `--aplicar` falla a propósito (ver `divisor-nomina.ts`).
 *
 *   pnpm build
 *   node dist/datos/2026-10-divisor-nomina-informe.js --empresa <id>
 *   node dist/datos/2026-10-divisor-nomina-informe.js --todas
 */

async function diferencias(app: INestApplicationContext) {
  const runs = app.get<Model<PayrollRunDocument>>(getModelToken(PayrollRun.name));
  const settings = app.get<Model<PayrollSettingsDocument>>(
    getModelToken(PayrollSettings.name),
  );
  const doc = await settings.findOne().lean().exec();
  const s = (doc ?? DEFAULT_PAYROLL_SETTINGS) as unknown as PayrollSettingsData;

  const lista = await runs
    .find({})
    .select('period status slips.employeeName slips.salarioBase slips.breakdown')
    .sort({ period: 1 })
    .lean()
    .exec();

  const out = [];
  for (const r of lista) {
    const d = diferenciaCorrida(
      { ...(r as unknown as CorridaGuardada), id: String(r._id) },
      s,
    );
    if (!d) continue;
    console.log(
      `  ${d.period} [${d.status}] ${d.id}: ${d.divisorUsado} h → ${d.divisorCorrecto} h, ` +
        `${d.colillasConHoras}/${d.colillas} colillas con horas, diferencia ${d.diferencia} COP`,
    );
    out.push(d);
  }
  return out;
}

void enCadaEmpresa({
  nombre: 'informe de nóminas liquidadas con un divisor del valor hora distinto al vigente (Ley 2101)',
  contar: async (app) => contarDivisor(await diferencias(app)),
  aplicar: () =>
    Promise.reject(
      new Error('Solo informe: reliquidar una nómina cerrada no se hace por script.'),
    ),
});
