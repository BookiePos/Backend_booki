import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import type { Model } from 'mongoose';
import { enCadaEmpresa } from './en-cada-empresa';
import { llaveDocumento, planSaldoFavorHistorico, type VentaHistorica } from './saldo-favor-historico';
import { SaleReturn, type SaleReturnDocument } from '../modules/sales/infrastructure/schemas/sale-return.schema';
import { Sale, type SaleDocument } from '../modules/sales/infrastructure/schemas/sale.schema';
import {
  SaldoFavorMovimiento,
  type SaldoFavorMovimientoDocument,
} from '../modules/sales/infrastructure/schemas/saldo-favor.schema';
import { Customer, type CustomerDocument } from '../modules/customers/infrastructure/schemas/customer.schema';
import { SaldoFavorService } from '../modules/sales/application/saldo-favor.service';

/**
 * Por qué existe (revisión de la Fase 6C, #131): las devoluciones y rebajas
 * anteriores con `credit_note` o `none` acreditaron la 2805 sin tercero, así
 * que ese saldo no se puede gastar con el medio `saldo_favor` y sale como
 * `diferenciaLibro` en el reporte. Este script las atribuye a su cliente: la
 * venta trae `customerId` o, en las viejas, el documento del cliente
 * (`sale.customer.idNumber`), que se cruza con la ficha de clientes.
 *
 * Abona con `SaldoFavorService.abonar` (`sourceType: 'sale_return'`,
 * `sourceId` = id de la devolución): es el mismo origen que usa la devolución
 * de hoy, así que es IDEMPOTENTE (el índice único del auxiliar lo garantiza) y
 * no toca el libro, que ya acreditó la 2805. Lo que no puede atribuir lo
 * informa en el log y lo deja como está.
 *
 *   pnpm build
 *   node dist/datos/2026-11-saldo-favor-historico.js --empresa <id>
 *   node dist/datos/2026-11-saldo-favor-historico.js --empresa <id> --aplicar
 *   node dist/datos/2026-11-saldo-favor-historico.js --todas
 *   node dist/datos/2026-11-saldo-favor-historico.js --todas --aplicar
 */

const logger = new Logger('SaldoFavorHistorico');

async function armarPlan(app: INestApplicationContext) {
  const devoluciones = app.get<Model<SaleReturnDocument>>(getModelToken(SaleReturn.name));
  const ventas = app.get<Model<SaleDocument>>(getModelToken(Sale.name));
  const clientes = app.get<Model<CustomerDocument>>(getModelToken(Customer.name));
  const movimientos = app.get<Model<SaldoFavorMovimientoDocument>>(getModelToken(SaldoFavorMovimiento.name));

  const candidatas = await devoluciones.find({ refundMethod: { $in: ['credit_note', 'none'] } }).exec();
  const ventaIds = [...new Set(candidatas.map((d) => String(d.saleId)))];
  const filasVenta = await ventas.find({ _id: { $in: ventaIds } }).select({ saleNumber: 1, customerId: 1, customer: 1 }).exec();
  const porVenta = new Map<string, VentaHistorica>(
    filasVenta.map((v) => [
      String(v._id),
      {
        id: String(v._id),
        saleNumber: v.saleNumber,
        customerId: v.customerId ? String(v.customerId) : undefined,
        docNumber: v.customer?.idNumber,
        customerName: v.customer?.name,
      },
    ]),
  );
  const docs = [...new Set(filasVenta.map((v) => llaveDocumento(v.customer?.idNumber)).filter(Boolean))];
  const filasCliente = docs.length ? await clientes.find({}).select({ docNumber: 1, name: 1 }).exec() : [];
  const porDoc = new Map<string, { id: string; name?: string }>();
  for (const c of filasCliente) {
    const k = llaveDocumento(c.docNumber);
    if (k && docs.includes(k) && !porDoc.has(k)) porDoc.set(k, { id: String(c._id), name: c.name });
  }
  const ya = new Set(
    (
      await movimientos
        .find({ sourceType: 'sale_return', tipo: 'abono', sourceId: { $in: candidatas.map((d) => String(d._id)) } })
        .select({ sourceId: 1 })
        .exec()
    ).map((m) => m.sourceId),
  );
  return planSaldoFavorHistorico(
    candidatas.map((d) => ({
      id: String(d._id),
      saleId: String(d.saleId),
      refundMethod: d.refundMethod,
      refundTotal: d.refundTotal,
      abonoCartera: d.abonoCartera,
      tipRefund: d.tipRefund,
    })),
    porVenta,
    porDoc,
    ya,
  );
}

void enCadaEmpresa({
  nombre: 'atribuir a su cliente el saldo a favor (2805) de las devoluciones anteriores a la Fase 6C',
  contar: async (app) => {
    const plan = await armarPlan(app);
    for (const s of plan.sinCliente) {
      logger.warn(`Sin atribuir: devolución ${s.returnId} (venta ${s.saleNumber ?? '?'}) por $${s.amount}: ${s.motivo}.`);
    }
    return {
      porAtribuir: plan.abonos.length,
      pesosPorAtribuir: plan.abonos.reduce((t, a) => t + a.amount, 0),
      yaAtribuidas: plan.yaAtribuidas,
      sinCliente: plan.sinCliente.length,
    };
  },
  aplicar: async (app) => {
    const saldoFavor = app.get(SaldoFavorService, { strict: false });
    const plan = await armarPlan(app);
    for (const a of plan.abonos) {
      await saldoFavor.abonar({
        customerId: a.customerId,
        customerName: a.customerName,
        amount: a.amount,
        sourceType: 'sale_return',
        sourceId: a.returnId,
        memo: a.memo,
      });
    }
  },
});
