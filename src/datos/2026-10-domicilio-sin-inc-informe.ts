import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  aplicarDomicilioSinInc,
  contarDomicilioSinInc,
  type VentaConDomicilio,
} from './domicilio-sin-inc';
import { Sale, type SaleDocument } from '../modules/sales/infrastructure/schemas/sale.schema';
import { TenantContext } from '../shared/tenancy/tenant-context';

/**
 * Por qué existe: hasta oct-2026 el domicilio del restaurante se cobraba sin
 * INC (iba entero a ingresos). Este script SOLO LISTA, por empresa y por mes,
 * cuántas ventas completadas llevaron domicilio sin impuesto, cuánto se cobró y
 * el INC del 8 % que llevaría incluido. No escribe: `--aplicar` falla a
 * propósito (ver `domicilio-sin-inc.ts`).
 *
 *   pnpm build
 *   node dist/datos/2026-10-domicilio-sin-inc-informe.js --empresa <id>
 *   node dist/datos/2026-10-domicilio-sin-inc-informe.js --todas
 */
void enCadaEmpresa({
  nombre: 'informe de domicilio cobrado sin INC antes de oct-2026',
  contar: async (app) => {
    // Fuera de un restaurante el domicilio sigue sin impuesto: no hay nada que informar.
    if (TenantContext.current()?.tipoNegocio !== 'restaurante') return {};
    const sales = app.get<Model<SaleDocument>>(getModelToken(Sale.name));
    const ventas = await sales
      .find({ status: 'completed', deliveryFee: { $gt: 0 } })
      .select('deliveryFee deliveryTaxKind soldAt createdAt')
      .lean()
      .exec();
    return contarDomicilioSinInc(ventas as unknown as VentaConDomicilio[]);
  },
  aplicar: aplicarDomicilioSinInc,
});
