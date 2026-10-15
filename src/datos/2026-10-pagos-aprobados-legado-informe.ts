import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { enCadaEmpresa } from './en-cada-empresa';
import { FILTRO_PAGOS_LEGADO, contarLegado, type PagoLegado } from './pagos-aprobados-legado';
import { TenantContext } from '../shared/tenancy/tenant-context';
import { CONTROL_CONNECTION } from '../modules/control/domain/control.constants';
import {
  Payment,
  type PaymentDocument,
} from '../modules/billing/infrastructure/schemas/payment.schema';

/**
 * Por qué existe (checklist 1.14): `applyApproved` pasó a reservar con
 * `applyVersion` y a anotar sus pasos. Los pagos `approved` sin `applied` del
 * código anterior no dicen qué efectos hicieron, y el barrido ya no los
 * retoma para no duplicar documentos ni períodos. Este script SOLO LISTA esos
 * pagos por empresa para revisarlos a mano. No escribe: `--aplicar` falla.
 *
 * `billing_payments` vive en el control-plane; se filtra por la empresa del
 * contexto que abre `enCadaEmpresa`. `--todas` solo recorre trial/active: una
 * suspendida se revisa con `--empresa <id>`.
 *
 *   pnpm build
 *   node dist/datos/2026-10-pagos-aprobados-legado-informe.js --empresa <id>
 *   node dist/datos/2026-10-pagos-aprobados-legado-informe.js --todas
 */
async function pagosLegado(app: INestApplicationContext): Promise<PagoLegado[]> {
  const payments = app.get<Model<PaymentDocument>>(
    getModelToken(Payment.name, CONTROL_CONNECTION),
  );
  const { businessId } = TenantContext.currentOrThrow();
  const filas = await payments
    .find({ businessId, ...FILTRO_PAGOS_LEGADO })
    .select('reference kind amountInCents wompiTransactionId createdAt')
    .sort({ createdAt: 1 })
    .lean()
    .exec();

  return filas.map((f) => {
    console.log(
      `  ${f.reference} [${f.kind}] ${f.amountInCents / 100} COP, ` +
        `transacción ${f.wompiTransactionId ?? '—'}`,
    );
    return {
      id: String(f._id),
      reference: f.reference,
      kind: f.kind,
      amountInCents: f.amountInCents,
    };
  });
}

void enCadaEmpresa({
  nombre: 'informe de pagos aprobados sin aplicar del código anterior (revisión a mano)',
  contar: async (app) => contarLegado(await pagosLegado(app)),
  aplicar: () =>
    Promise.reject(
      new Error('Solo informe: estos pagos se revisan a mano contra Wompi y la empresa.'),
    ),
});
