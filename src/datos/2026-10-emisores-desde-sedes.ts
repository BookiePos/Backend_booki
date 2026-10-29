import { Logger, type INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  nitEnmascarado,
  planificarEmisores,
  type EmisorExistente,
  type SedeParaPlan,
} from './emisores-desde-sedes';
import { diferenciasFiscales } from '../modules/einvoicing/domain/emisor-fiscal';
import {
  Sede,
  type SedeDocument,
} from '../modules/sedes/infrastructure/schemas/sede.schema';
import {
  FiscalEmitter,
  type FiscalEmitterDocument,
} from '../modules/einvoicing/infrastructure/schemas/fiscal-emitter.schema';

/**
 * Por qué existe (checklist 1, Fase 1): la configuración de factura electrónica
 * se ancla al emisor (NIT) y no a la sede. Este script crea un emisor en
 * `fiscal_emitters` por cada NIT normalizado de las sedes, copiando los datos
 * fiscales que la sede ya tiene, y pone `emisorId` en cada sede.
 *
 *   - Las sedes sin NIT se cuentan y se dejan sin emisor.
 *   - Si dos sedes con el mismo NIT (o la sede y el emisor existente) difieren
 *     en la identidad fiscal (razón social, DV, tipo de persona,
 *     responsabilidades, régimen, CIIU), el NIT se reporta y se salta: no se elige.
 *   - El contacto (dirección, ciudad, correo, teléfono) que no coincide entre
 *     sedes queda vacío en el emisor y se reporta.
 *   - No toca los datos de la sede: la emisión actual sigue leyéndolos de ahí.
 *
 * Idempotente: las sedes ya enlazadas a un emisor de su NIT no se tocan, y el
 * índice único de `nitNorm` impide un segundo emisor del mismo NIT.
 *
 *   pnpm build
 *   node dist/datos/2026-10-emisores-desde-sedes.js --empresa <id>
 *   node dist/datos/2026-10-emisores-desde-sedes.js --empresa <id> --aplicar
 *   node dist/datos/2026-10-emisores-desde-sedes.js --todas
 *   node dist/datos/2026-10-emisores-desde-sedes.js --todas --aplicar
 */

const logger = new Logger('EmisoresDesdeSedes');

const CAMPOS_SEDE =
  'name businessName nit nitDv tipoPersona responsabilidadFiscal responsableIva ' +
  'responsableInc franquicia granContribuyente regimenRenta ciiu address ' +
  'departamento ciudad phone emailFacturacion emisorId';

const CAMPOS_EMISOR =
  'razonSocial nit nitNorm nitDv tipoPersona responsabilidadFiscal responsableIva ' +
  'responsableInc franquicia granContribuyente regimenRenta ciiu';

const modelos = (app: INestApplicationContext) => ({
  sedes: app.get<Model<SedeDocument>>(getModelToken(Sede.name)),
  emisores: app.get<Model<FiscalEmitterDocument>>(getModelToken(FiscalEmitter.name)),
});

type Fila = Record<string, unknown> & { _id: Types.ObjectId };

/** Pasa ObjectId a texto y deja el resto como está. */
const plano = (f: Fila) => {
  const { _id, emisorId, ...resto } = f;
  return {
    ...resto,
    id: _id.toString(),
    ...(emisorId ? { emisorId: String(emisorId) } : {}),
  };
};

async function leerPlan(app: INestApplicationContext) {
  const { sedes, emisores } = modelos(app);
  // Proyección explícita: ni la clave técnica de la resolución ni nada más sale de la base.
  const filasSedes = (await sedes.find({}).select(CAMPOS_SEDE).lean().exec()) as unknown as Fila[];
  const filasEmisores = (await emisores
    .find({})
    .select(CAMPOS_EMISOR)
    .lean()
    .exec()) as unknown as Fila[];
  const plan = planificarEmisores(
    filasSedes.map(plano) as SedeParaPlan[],
    filasEmisores.map(plano) as EmisorExistente[],
  );
  return { plan, sedes: filasSedes.length, emisores: filasEmisores.length };
}

void enCadaEmpresa({
  nombre: 'crear emisores fiscales desde las sedes y enlazarlas (sede.emisorId)',
  contar: async (app) => {
    const { plan, sedes, emisores } = await leerPlan(app);
    for (const c of plan.conflictos) {
      logger.warn(
        `NIT ${nitEnmascarado(c.nitNorm)} saltado: ${c.sedeIds.length} sede(s) con datos ` +
          `fiscales distintos en ${c.campos.join(', ')}. Corrígelo en las sedes y repite.`,
      );
    }
    for (const c of plan.crear) {
      if (c.contactoOmitido.length > 0) {
        logger.warn(
          `NIT ${nitEnmascarado(c.nitNorm)}: sin copiar ${c.contactoOmitido.join(', ')} ` +
            '(las sedes no coinciden); se completa a mano.',
        );
      }
    }
    const porEnlazar =
      plan.crear.reduce((n, c) => n + c.sedeIds.length, 0) +
      plan.enlazar.reduce((n, e) => n + e.sedeIds.length, 0);
    return {
      sedes,
      emisores,
      sedesSinNit: plan.sedesSinNit.length,
      sedesEnlazadas: plan.sedesEnlazadas,
      sedesPorEnlazar: porEnlazar,
      emisoresPorCrear: plan.crear.length,
      nitsEnConflicto: plan.conflictos.length,
      sedesEnConflicto: plan.conflictos.reduce((n, c) => n + c.sedeIds.length, 0),
    };
  },
  aplicar: async (app) => {
    const { sedes, emisores } = modelos(app);
    const { plan } = await leerPlan(app);
    const enlazar = (emisorId: Types.ObjectId, sedeIds: string[]) =>
      sedes
        .updateMany(
          { _id: { $in: sedeIds.map((id) => new Types.ObjectId(id)) } },
          { $set: { emisorId } },
        )
        .exec();

    for (const c of plan.crear) {
      let emisor: FiscalEmitterDocument | null;
      try {
        emisor = await emisores.create(c.datos);
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
        // Lo creó otra corrida a la vez. Solo se enlaza si coincide en la
        // identidad fiscal; si no, es un conflicto como cualquier otro.
        emisor = await emisores.findOne({ nitNorm: c.nitNorm }).exec();
        if (!emisor) {
          // Sin el mensaje crudo del E11000: lleva el NIT en claro.
          throw new Error(
            `NIT ${nitEnmascarado(c.nitNorm)}: choque del índice único sin emisor que lo explique`,
          );
        }
        const campos = diferenciasFiscales(emisor, c.datos);
        if (campos.length > 0) {
          logger.warn(
            `NIT ${nitEnmascarado(c.nitNorm)} saltado: el emisor creado a la vez difiere en ` +
              `${campos.join(', ')}. Corrígelo y repite.`,
          );
          continue;
        }
      }
      await enlazar(emisor._id, c.sedeIds);
    }
    for (const e of plan.enlazar) {
      await enlazar(new Types.ObjectId(e.emisorId), e.sedeIds);
    }
  },
});
