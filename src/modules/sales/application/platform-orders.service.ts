import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../infrastructure/schemas/sale.schema';
import {
  PlatformSettlement,
  PlatformSettlementDocument,
} from '../infrastructure/schemas/platform-settlement.schema';
import {
  CajaSession,
  CajaSessionDocument,
} from '../../caja/infrastructure/schemas/caja-session.schema';
import { CatalogService } from '../../catalog/application/catalog.service';
import { SalesService } from './sales.service';
import { ImportPlatformOrdersDto } from './dto/platform-orders.dto';
import {
  MAX_IMPORT_ORDERS,
  PLATFORM_CODES,
  PLATFORM_LABELS,
  PlatformCode,
  indexProducts,
  matchProduct,
  parsePlatformCsv,
  type RowError,
} from '../domain/platform-orders';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { cop, sumBy } from '../../finance/domain/money.util';

export type PreviewStatus = 'ok' | 'duplicado' | 'error';

export interface PreviewLine {
  line: number;
  name?: string;
  sku?: string;
  qty: number;
  productId?: string;
  productName?: string;
  /** Precio del POS (nunca el del portal). */
  unitPrice?: number;
  error?: string;
}

export interface PreviewOrder {
  externalId: string;
  orderedAt?: string;
  status: PreviewStatus;
  /** Si ya existe, la venta que lo registró. */
  saleNumber?: string;
  /** Total aproximado con precios de mostrador; el real sale al crear (listas, descuentos). */
  total: number;
  reportedTotal?: number;
  commissionEstimate?: number;
  lines: PreviewLine[];
  errors: string[];
  warnings: string[];
}

export interface PreviewResult {
  platform: PlatformCode;
  orders: PreviewOrder[];
  fileErrors: RowError[];
  summary: { ok: number; duplicado: number; error: number };
}

export interface ImportRowResult {
  externalId: string;
  status: 'creado' | 'duplicado' | 'error';
  saleNumber?: string;
  message?: string;
}

/**
 * Pedidos de plataformas de domicilio (ítem 7.5): vista previa e importación del
 * CSV del portal de aliados, listado y reporte de saldo por cobrar.
 *
 * No reimplementa la venta: cada pedido pasa por `SalesService.create`, así que
 * descuenta inventario, valida la sede y deja el asiento a Clientes (1305) igual
 * que un registro manual. Los precios son SIEMPRE los del POS, no los del CSV.
 */
@Injectable()
export class PlatformOrdersService {
  constructor(
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(PlatformSettlement.name)
    private readonly settlementModel: Model<PlatformSettlementDocument>,
    @InjectModel(CajaSession.name)
    private readonly cajaSessionModel: Model<CajaSessionDocument>,
    private readonly catalog: CatalogService,
    private readonly sales: SalesService,
  ) {}

  /** Lee el CSV, lo empareja con el catálogo y marca duplicados. No escribe nada. */
  async preview(dto: ImportPlatformOrdersDto, user: JwtUser): Promise<PreviewResult> {
    assertSedeAccess(user, dto.sedeId);
    const parsed = parsePlatformCsv(dto.csv);
    if (parsed.orders.length > MAX_IMPORT_ORDERS) {
      throw new BadRequestException(
        `El archivo trae ${parsed.orders.length} pedidos; el máximo por importación es ${MAX_IMPORT_ORDERS}. Divídelo.`,
      );
    }
    const products = await this.catalog.listSellable();
    const index = indexProducts(
      products.map((p) => ({ id: p.id as string, sku: p.sku ?? '', name: p.name })),
    );
    const priceById = new Map(products.map((p) => [p.id as string, p.salePrice]));

    const existentes = await this.saleModel
      .find({
        'platform.code': dto.platform,
        'platform.externalId': { $in: parsed.orders.map((o) => o.externalId) },
        status: 'completed',
      })
      .select('saleNumber platform.externalId')
      .exec();
    const yaRegistrado = new Map(
      existentes.map((s) => [s.platform!.externalId, s.saleNumber] as const),
    );

    const orders: PreviewOrder[] = parsed.orders.map((o) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const lines: PreviewLine[] = o.lines.map((l) => {
        const m = matchProduct(l, index);
        if (!m.ok) {
          errors.push(`Línea ${l.line}: ${m.message}`);
          return { ...l, error: m.message };
        }
        return {
          ...l,
          productId: m.productId,
          productName: m.name,
          unitPrice: priceById.get(m.productId),
        };
      });
      const total = sumBy(lines, (l) => (l.unitPrice ?? 0) * l.qty);
      if (o.reportedTotal !== undefined && errors.length === 0 && o.reportedTotal !== total) {
        warnings.push(
          `El total del portal ($${o.reportedTotal}) no coincide con el del POS ($${total}): se cobra con los precios del POS.`,
        );
      }
      const saleNumber = yaRegistrado.get(o.externalId);
      const status: PreviewStatus = saleNumber ? 'duplicado' : errors.length > 0 ? 'error' : 'ok';
      return {
        externalId: o.externalId,
        orderedAt: o.orderedAt,
        status,
        saleNumber,
        total,
        reportedTotal: o.reportedTotal,
        commissionEstimate: o.commission,
        lines,
        errors,
        warnings,
      };
    });
    return {
      platform: dto.platform,
      orders,
      fileErrors: parsed.errors,
      summary: {
        ok: orders.filter((o) => o.status === 'ok').length,
        duplicado: orders.filter((o) => o.status === 'duplicado').length,
        error: orders.filter((o) => o.status === 'error').length + parsed.errors.length,
      },
    };
  }

  /**
   * Crea las ventas de los pedidos que la vista previa dejó en `ok`. Idempotente
   * por (plataforma, código): lo que ya existe sale como `duplicado` y no se
   * toca, así que repetir la importación del mismo archivo no duplica nada.
   * Un pedido con error no frena a los demás.
   */
  async import(dto: ImportPlatformOrdersDto, user: JwtUser) {
    const preview = await this.preview(dto, user);
    const abierta = await this.cajaSessionModel
      .findOne({ sedeId: new Types.ObjectId(dto.sedeId), status: 'open' })
      .select('_id')
      .exec();
    if (!abierta) {
      throw new BadRequestException(
        'Debes abrir la caja de la sede antes de importar pedidos: quedan ligados al turno',
      );
    }
    const results: ImportRowResult[] = [];
    for (const o of preview.orders) {
      if (o.status === 'duplicado') {
        results.push({ externalId: o.externalId, status: 'duplicado', saleNumber: o.saleNumber });
        continue;
      }
      if (o.status === 'error') {
        results.push({ externalId: o.externalId, status: 'error', message: o.errors.join(' · ') });
        continue;
      }
      try {
        const sale = await this.sales.create(
          {
            sedeId: dto.sedeId,
            lines: o.lines.map((l) => ({ productId: l.productId!, qty: l.qty })),
            payment: { method: 'platform' },
            orderType: 'llevar',
            platform: {
              code: dto.platform,
              externalId: o.externalId,
              orderedAt: o.orderedAt,
              commissionEstimate: o.commissionEstimate,
            },
          },
          user,
        );
        results.push({ externalId: o.externalId, status: 'creado', saleNumber: sale.saleNumber });
      } catch (err) {
        const message =
          err instanceof HttpException
            ? this.messageOf(err)
            : 'No se pudo registrar el pedido';
        // Dos importaciones simultáneas: el que pierde la carrera ve el pedido como duplicado.
        const dup = err instanceof HttpException && err.getStatus() === 409;
        results.push({
          externalId: o.externalId,
          status: dup ? 'duplicado' : 'error',
          message,
        });
      }
    }
    return {
      platform: dto.platform,
      fileErrors: preview.fileErrors,
      results,
      summary: {
        creado: results.filter((r) => r.status === 'creado').length,
        duplicado: results.filter((r) => r.status === 'duplicado').length,
        error: results.filter((r) => r.status === 'error').length + preview.fileErrors.length,
      },
    };
  }

  private messageOf(err: HttpException): string {
    const r = err.getResponse();
    const m = typeof r === 'string' ? r : (r as { message?: string | string[] }).message;
    return Array.isArray(m) ? m.join(' · ') : (m ?? err.message);
  }

  /** Pedidos de plataforma de una sede; `pending` deja solo los que la plataforma aún debe. */
  async list(
    q: { sedeId: string; platform?: PlatformCode; pending?: boolean; limit?: number },
    user: JwtUser,
  ) {
    assertSedeAccess(user, q.sedeId);
    const filter: Record<string, unknown> = {
      sedeId: new Types.ObjectId(q.sedeId),
      status: 'completed',
      'platform.code': q.platform ?? { $in: PLATFORM_CODES },
    };
    if (q.pending) filter['platform.settlementId'] = { $exists: false };
    const rows = await this.saleModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(q.limit ?? 200, 1), 500))
      .select('saleNumber total deliveryFee platform createdAt')
      .exec();
    return rows.map((s) => ({
      id: s.id as string,
      saleNumber: s.saleNumber,
      platform: s.platform!.code,
      externalId: s.platform!.externalId,
      orderedAt: s.platform!.orderedAt,
      commissionEstimate: s.platform!.commissionEstimate ?? 0,
      amount: cop(s.total + (s.deliveryFee ?? 0)),
      settled: Boolean(s.platform!.settlementId),
      settlementId: s.platform!.settlementId?.toString(),
    }));
  }

  /**
   * Ventas por plataforma en un rango y lo que cada una DEBE hoy. El saldo por
   * cobrar no depende del rango: es todo lo vendido y no liquidado.
   */
  async summary(
    q: { sedeId: string; from?: string; to?: string },
    user: JwtUser,
  ) {
    assertSedeAccess(user, q.sedeId);
    const sedeId = new Types.ObjectId(q.sedeId);
    const base = { sedeId, status: 'completed', 'platform.code': { $in: [...PLATFORM_CODES] } };
    const rango: Record<string, Date> = {};
    if (q.from) rango.$gte = new Date(`${q.from}T00:00:00-05:00`);
    if (q.to) rango.$lte = new Date(`${q.to}T23:59:59.999-05:00`);
    const amount = { $add: ['$total', { $ifNull: ['$deliveryFee', 0] }] };

    const [ventas, saldos, liquidaciones] = await Promise.all([
      this.saleModel
        .aggregate<{ _id: PlatformCode; orders: number; sales: number; commissionEstimate: number }>([
          { $match: { ...base, ...(q.from || q.to ? { createdAt: rango } : {}) } },
          {
            $group: {
              _id: '$platform.code',
              orders: { $sum: 1 },
              sales: { $sum: amount },
              commissionEstimate: { $sum: { $ifNull: ['$platform.commissionEstimate', 0] } },
            },
          },
        ])
        .exec(),
      this.saleModel
        .aggregate<{ _id: PlatformCode; pendingOrders: number; pendingAmount: number }>([
          { $match: { ...base, 'platform.settlementId': { $exists: false } } },
          { $group: { _id: '$platform.code', pendingOrders: { $sum: 1 }, pendingAmount: { $sum: amount } } },
        ])
        .exec(),
      this.settlementModel
        .aggregate<{
          _id: PlatformCode;
          settlements: number;
          received: number;
          commission: number;
          commissionIva: number;
        }>([
          {
            $match: {
              sedeId,
              status: 'active',
              ...(q.from || q.to
                ? { date: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } }
                : {}),
            },
          },
          {
            $group: {
              _id: '$platform',
              settlements: { $sum: 1 },
              received: { $sum: '$received' },
              commission: { $sum: '$commission' },
              commissionIva: { $sum: '$commissionIva' },
            },
          },
        ])
        .exec(),
    ]);

    const rows = PLATFORM_CODES.map((code) => {
      const v = ventas.find((x) => x._id === code);
      const s = saldos.find((x) => x._id === code);
      const l = liquidaciones.find((x) => x._id === code);
      return {
        platform: code,
        label: PLATFORM_LABELS[code],
        orders: v?.orders ?? 0,
        sales: cop(v?.sales ?? 0),
        commissionEstimate: cop(v?.commissionEstimate ?? 0),
        pendingOrders: s?.pendingOrders ?? 0,
        /** Lo que la plataforma le debe hoy al negocio. */
        pendingAmount: cop(s?.pendingAmount ?? 0),
        settlements: l?.settlements ?? 0,
        received: cop(l?.received ?? 0),
        commission: cop(l?.commission ?? 0),
        commissionIva: cop(l?.commissionIva ?? 0),
      };
    }).filter((r) => r.orders > 0 || r.pendingOrders > 0 || r.settlements > 0);

    return {
      rows,
      totals: {
        sales: sumBy(rows, (r) => r.sales),
        pendingAmount: sumBy(rows, (r) => r.pendingAmount),
        commission: sumBy(rows, (r) => r.commission),
      },
    };
  }
}
