import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  contarExcesos,
  excesosExpediente,
  excesosParametros,
  revisarAMano,
  type VigenciaParametro,
} from './recargos-sobre-legal';
import {
  PayrollSettings,
  type PayrollSettingsDocument,
} from '../modules/payroll/infrastructure/schemas/payroll-settings.schema';
import {
  Parameter,
  type ParameterDocument,
} from '../modules/core-params/infrastructure/schemas/parameter.schema';

/**
 * Por qué existe (revisión del ítem 1.18, H3): nómina dejó de leer el
 * dominical y los combinados del expediente y las vigencias de recargos sin
 * autor en Parámetros. Este script SOLO LISTA las empresas donde esos valores
 * superan el legal (`recargosVigentes`), para revisar a mano si hubo un pacto.
 * No escribe: `--aplicar` falla a propósito (ver `recargos-sobre-legal.ts`).
 *
 *   pnpm build
 *   node dist/datos/2026-10-recargos-sobre-legal-informe.js --empresa <id>
 *   node dist/datos/2026-10-recargos-sobre-legal-informe.js --todas
 */

function hoyColombia(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

async function contar(app: INestApplicationContext) {
  const settings = app.get<Model<PayrollSettingsDocument>>(
    getModelToken(PayrollSettings.name),
  );
  const params = app.get<Model<ParameterDocument>>(getModelToken(Parameter.name));

  const doc = await settings.findOne().select('recargos').lean().exec();
  const expediente = excesosExpediente(doc?.recargos, hoyColombia());
  const versiones = (await params
    .find({ key: /^recargo\./ })
    .select('key value effectiveFrom createdByEmail')
    .sort({ key: 1, effectiveFrom: 1 })
    .lean()
    .exec()) as unknown as VigenciaParametro[];
  const parametros = excesosParametros(versiones);

  for (const e of [...expediente, ...parametros]) {
    console.log(
      `  [${e.origen}] ${e.campo} desde ${e.desde}: ${e.valor} > legal ${e.legal}`,
    );
  }
  return contarExcesos(expediente, parametros);
}

void enCadaEmpresa({
  nombre: 'informe de recargos guardados por encima del legal que nómina ya no lee (revisión 1.18)',
  contar,
  aplicar: revisarAMano,
});
