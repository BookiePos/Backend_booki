import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import { proponerTipoDian } from '../modules/customers/domain/datos-fiscales';
import {
  Customer,
  type CustomerDocument,
} from '../modules/customers/infrastructure/schemas/customer.schema';

/**
 * Por qué existe (checklist 1, Fase 2, «Adquiriente capturado del cliente»):
 * la factura ya no adivina el tipo de documento por el largo del número, así
 * que los clientes anteriores (que solo tienen el `docType` histórico) saldrían
 * como consumidor final. Este script propone `dianDocType` SOLO cuando es
 * inequívoco:
 *
 *   - `docType` NIT, número escrito con guion y el DV del guion cuadra con el
 *     módulo 11 de la DIAN -> `dianDocType` '31' y `nitDv` con ese DV.
 *
 * Todo lo demás (cédulas, NIT sin guion, DV que no cuadra, pasaportes…) se
 * cuenta como ambiguo y NO se toca: lo completa quien conoce al cliente en su
 * ficha. No cambia `docNumber` (es parte del índice único) ni el `docType`.
 *
 * Idempotente: el filtro excluye a los clientes que ya tienen `dianDocType`.
 *
 *   pnpm build
 *   node dist/datos/2026-10-tipo-documento-dian-clientes.js --empresa <id>
 *   node dist/datos/2026-10-tipo-documento-dian-clientes.js --empresa <id> --aplicar
 *   node dist/datos/2026-10-tipo-documento-dian-clientes.js --todas
 *   node dist/datos/2026-10-tipo-documento-dian-clientes.js --todas --aplicar
 */

const SIN_TIPO_DIAN = {
  $or: [{ dianDocType: { $exists: false } }, { dianDocType: null }],
};

const modelo = (
  app: Parameters<Parameters<typeof enCadaEmpresa>[0]['contar']>[0],
) => app.get<Model<CustomerDocument>>(getModelToken(Customer.name));

async function sinTipo(
  app: Parameters<Parameters<typeof enCadaEmpresa>[0]['contar']>[0],
) {
  return modelo(app)
    .find(SIN_TIPO_DIAN)
    .select('docType docNumber')
    .lean()
    .exec();
}

void enCadaEmpresa({
  nombre: 'proponer el tipo de documento DIAN de los clientes (solo lo inequívoco)',
  contar: async (app) => {
    const clientes = await sinTipo(app);
    const proponibles = clientes.filter((c) => proponerTipoDian(c)).length;
    return {
      sinTipoDian: clientes.length,
      proponibles,
      ambiguosSinTocar: clientes.length - proponibles,
    };
  },
  aplicar: async (app) => {
    for (const c of await sinTipo(app)) {
      const propuesta = proponerTipoDian(c);
      if (!propuesta) continue;
      await modelo(app)
        .updateOne({ _id: c._id, ...SIN_TIPO_DIAN }, { $set: propuesta })
        .exec();
    }
  },
});
