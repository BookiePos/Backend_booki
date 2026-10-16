import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { enCadaEmpresa } from './en-cada-empresa';
import {
  reconstruirAsientos,
  type FuentesReconstruccion,
  type GastoGuardado,
  type OrdenGuardada,
  type VentaGuardada,
} from './reconstruir-asientos';
import { LedgerPostingService } from '../modules/core-ledger/application/ledger-posting.service';
import { LedgerConciliacionService } from '../modules/core-ledger/application/ledger-conciliacion.service';
import {
  JournalEntry,
  type JournalEntryDocument,
} from '../modules/core-ledger/infrastructure/schemas/journal-entry.schema';
import { Sale, type SaleDocument } from '../modules/sales/infrastructure/schemas/sale.schema';
import {
  FinanceExpense,
  type FinanceExpenseDocument,
} from '../modules/finance/infrastructure/schemas/finance-expense.schema';
import {
  FinanceCategory,
  type FinanceCategoryDocument,
} from '../modules/finance/infrastructure/schemas/finance-category.schema';
import {
  PurchaseOrder,
  type PurchaseOrderDocument,
} from '../modules/purchasing/infrastructure/schemas/purchase-order.schema';
import { Sede, type SedeDocument } from '../modules/sedes/infrastructure/schemas/sede.schema';
import { BusinessService } from '../modules/control/application/business.service';
import { ivaDescontablePorSede } from '../modules/core-tax/application/perfil-fiscal';
import type { CategoryKind } from '../modules/finance/domain/finance.constants';

/**
 * Por qué existe (checklist 1.13): el posteo al libro es best-effort y, cuando
 * falla, la venta, el gasto o la compra quedan sin asiento (o con un asiento
 * vivo de algo anulado). Este script los reconstruye con la misma lógica de
 * `LedgerPostingService` y resuelve los pendientes de conciliación. Qué arregla
 * y qué solo cuenta: ver `reconstruir-asientos.ts`.
 *
 * Idempotente: el índice único del libro impide duplicar y lo que ya tiene
 * asiento no se toca. Correr ANTES el informe de duplicados
 * (`2026-10-duplicados-libro-informe.ts`): sin el índice creado, la
 * idempotencia descansa solo en la búsqueda previa.
 *
 *   pnpm build
 *   node dist/datos/2026-10-reconstruir-asientos.js --empresa <id>
 *   node dist/datos/2026-10-reconstruir-asientos.js --empresa <id> --aplicar
 *   node dist/datos/2026-10-reconstruir-asientos.js --todas
 *   node dist/datos/2026-10-reconstruir-asientos.js --todas --aplicar
 */

const id = (v: unknown) => String(v);

function fuentes(app: INestApplicationContext): FuentesReconstruccion {
  const entries = app.get<Model<JournalEntryDocument>>(getModelToken(JournalEntry.name));
  const sales = app.get<Model<SaleDocument>>(getModelToken(Sale.name));
  const expenses = app.get<Model<FinanceExpenseDocument>>(getModelToken(FinanceExpense.name));
  const categories = app.get<Model<FinanceCategoryDocument>>(getModelToken(FinanceCategory.name));
  const orders = app.get<Model<PurchaseOrderDocument>>(getModelToken(PurchaseOrder.name));
  const sedes = app.get<Model<SedeDocument>>(getModelToken(Sede.name));
  const conciliacion = app.get(LedgerConciliacionService);

  return {
    posting: app.get(LedgerPostingService),
    origenesRegistrados: async (sourceType) =>
      new Set(
        (await entries.distinct('sourceId', { sourceType, reversalOf: null }).exec()).map(id),
      ),
    origenesVivos: async (sourceType) =>
      new Set(
        (
          await entries
            .distinct('sourceId', { sourceType, reversalOf: null, reversedBy: null })
            .exec()
        ).map(id),
      ),
    ventas: async () => {
      const docs = await sales
        .find({})
        .select('saleNumber sedeId status total deliveryFee tip payment.method lines.taxKind lines.taxAmount components.cost createdAt')
        .lean()
        .exec();
      return docs.map(
        (s): VentaGuardada => ({
          id: id(s._id),
          saleNumber: s.saleNumber,
          sedeId: id(s.sedeId),
          status: s.status,
          total: s.total,
          deliveryFee: s.deliveryFee,
          tip: s.tip,
          paymentMethod: s.payment?.method,
          lines: s.lines ?? [],
          components: s.components ?? [],
          createdAt: (s as unknown as { createdAt: Date }).createdAt,
        }),
      );
    },
    gastos: async () => {
      const docs = await expenses.find({}).lean().exec();
      return docs.map(
        (g): GastoGuardado => ({
          id: id(g._id),
          sedeId: id(g.sedeId),
          categoryId: id(g.categoryId),
          concept: g.concept,
          amount: g.amount,
          taxAmount: g.taxAmount,
          withholdingAmount: g.withholdingAmount,
          date: g.date,
          status: g.status,
          paymentMethod: g.paymentMethod,
        }),
      );
    },
    ordenes: async () => {
      const docs = await orders
        .find({ 'receipts.0': { $exists: true } })
        .select('number sedeId lines.qty lines.unitCost lines.taxAmount receipts')
        .lean()
        .exec();
      return docs.map(
        (o): OrdenGuardada => ({
          id: id(o._id),
          number: o.number,
          sedeId: id(o.sedeId),
          lines: o.lines,
          receipts: o.receipts.map((r) => {
            const rid = (r as unknown as { _id?: unknown })._id;
            return {
              id: rid ? id(rid) : undefined,
              date: r.date,
              payableId: r.payableId ? id(r.payableId) : undefined,
              lines: r.lines,
            };
          }),
        }),
      );
    },
    naturalezaDeCategorias: async () => {
      const docs = await categories.find({}).select('kind').lean().exec();
      return new Map(docs.map((c) => [id(c._id), c.kind as CategoryKind]));
    },
    descuentaIva: async () => {
      const admite = await ivaDescontablePorSede({ sedes, businesses: app.get(BusinessService) });
      return (sedeId) => admite(sedeId);
    },
    // Todos, paginados: con más de una página no se pierde ninguno.
    pendientes: async () =>
      (await conciliacion.todosLosAbiertos()).map((p) => ({
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        operacion: p.operacion,
      })),
    resolver: (p) => conciliacion.resolver(p.sourceType, p.sourceId, p.operacion),
  };
}

void enCadaEmpresa({
  nombre: 'reconstruir asientos faltantes del libro y resolver pendientes de conciliación',
  contar: (app) => reconstruirAsientos(fuentes(app), false),
  aplicar: async (app) => {
    await reconstruirAsientos(fuentes(app), true);
  },
});
