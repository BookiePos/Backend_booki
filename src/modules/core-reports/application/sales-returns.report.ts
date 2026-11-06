import type { PipelineStage, Types } from 'mongoose';
import { cop } from '../../finance/domain/money.util';

/**
 * «Ventas por día» neto de devoluciones (riesgo R3 de la revisión 1.16).
 *
 * Criterio: la devolución resta el día EN QUE OCURRE, no el de la venta, igual
 * que la 4175 en el libro (art. 484 ET: la devolución disminuye el ingreso del
 * período en que se hace). Así el reporte cuadra con el estado de resultados.
 *
 * `refundTotal` es comparable con `sale.total`: los dos van con IVA/INC y sin
 * propina ni domicilio (R2: el domicilio queda fuera de la base).
 */

const TZ = 'America/Bogota';

/** `$facet` sobre `sale_returns`, agrupado por día de Colombia, sede, medio, motivo y producto. */
export const RETURNS_FACET: Extract<PipelineStage, { $facet: unknown }>['$facet'] =
  {
    days: [
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$createdAt',
              timezone: TZ,
            },
          },
          amount: { $sum: '$refundTotal' },
          tax: { $sum: '$refundTax' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ],
    bySede: [
      {
        $group: {
          _id: '$sedeId',
          amount: { $sum: '$refundTotal' },
          count: { $sum: 1 },
        },
      },
    ],
    byMethod: [
      {
        $group: {
          _id: '$refundMethod',
          amount: { $sum: '$refundTotal' },
          count: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ],
    byReason: [
      {
        $group: {
          _id: '$reason',
          amount: { $sum: '$refundTotal' },
          count: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ],
    products: [
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$lines.productId',
          name: { $first: '$lines.name' },
          qty: { $sum: '$lines.qty' },
          refund: { $sum: '$lines.refund' },
        },
      },
      { $sort: { refund: -1 } },
    ],
    totals: [
      {
        $group: {
          _id: null,
          amount: { $sum: '$refundTotal' },
          tax: { $sum: '$refundTax' },
          count: { $sum: 1 },
        },
      },
    ],
  };

/** Lo que devuelve el agregado `RETURNS_FACET`. */
export interface RetornosFacet {
  days: { _id: string; amount: number; tax: number; count: number }[];
  bySede: { _id: Types.ObjectId | null; amount: number; count: number }[];
  byMethod: { _id: string; amount: number; count: number }[];
  byReason: { _id: string; amount: number; count: number }[];
  products: {
    _id: Types.ObjectId | null;
    name: string;
    qty: number;
    refund: number;
  }[];
  totals: { amount: number; tax: number; count: number }[];
}

/** Lo que trae el agregado de ventas (`status: completed`). */
export interface VentasFacet {
  days: { _id: string; revenue: number; tax: number; tickets: number }[];
  bySede: { _id: Types.ObjectId | null; revenue: number; tickets: number }[];
  topProducts: {
    _id: Types.ObjectId | null;
    name: string;
    qty: number;
    revenue: number;
  }[];
  totals: { revenue: number; tax: number; tickets: number }[];
}

const idStr = (id: Types.ObjectId | string | null | undefined) =>
  id ? id.toString() : null;

const avg = (monto: number, tickets: number) =>
  tickets ? cop(monto / tickets) : 0;

/** Cuántos productos muestra el top. */
export const TOP_PRODUCTOS = 10;

/**
 * Netea las ventas con las devoluciones. Función pura: recibe los dos
 * agregados y arma el cuerpo del reporte (sin `from`/`to`/`sedeId`/`byMethod`).
 */
export function netearVentas(
  ventas: Partial<VentasFacet> | undefined,
  retornos: Partial<RetornosFacet> | undefined,
) {
  // --- Por día: la unión de los días con ventas y los días con devoluciones.
  const porDia = new Map<
    string,
    {
      gross: number;
      tax: number;
      tickets: number;
      ret: number;
      retTax: number;
      retCount: number;
    }
  >();
  const dia = (d: string) => {
    let r = porDia.get(d);
    if (!r) {
      r = { gross: 0, tax: 0, tickets: 0, ret: 0, retTax: 0, retCount: 0 };
      porDia.set(d, r);
    }
    return r;
  };
  for (const v of ventas?.days ?? []) {
    const r = dia(v._id);
    r.gross += v.revenue;
    r.tax += v.tax;
    r.tickets += v.tickets;
  }
  for (const d of retornos?.days ?? []) {
    const r = dia(d._id);
    r.ret += d.amount;
    r.retTax += d.tax;
    r.retCount += d.count;
  }
  const days = [...porDia.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, r]) => {
      const revenue = cop(r.gross - r.ret);
      return {
        date,
        grossRevenue: cop(r.gross),
        returns: cop(r.ret),
        returnsCount: r.retCount,
        revenue,
        tax: cop(r.tax - r.retTax),
        tickets: r.tickets,
        avgTicket: avg(revenue, r.tickets),
      };
    });

  // --- Por sede, neto.
  const porSede = new Map<
    string | null,
    { gross: number; tickets: number; ret: number; retCount: number }
  >();
  const sede = (k: string | null) => {
    let r = porSede.get(k);
    if (!r) {
      r = { gross: 0, tickets: 0, ret: 0, retCount: 0 };
      porSede.set(k, r);
    }
    return r;
  };
  for (const v of ventas?.bySede ?? []) {
    const r = sede(idStr(v._id));
    r.gross += v.revenue;
    r.tickets += v.tickets;
  }
  for (const d of retornos?.bySede ?? []) {
    const r = sede(idStr(d._id));
    r.ret += d.amount;
    r.retCount += d.count;
  }
  const bySede = [...porSede.entries()]
    .map(([sedeId, r]) => ({
      sedeId,
      grossRevenue: cop(r.gross),
      returns: cop(r.ret),
      returnsCount: r.retCount,
      revenue: cop(r.gross - r.ret),
      tickets: r.tickets,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // --- Top productos, neto; el top se recorta DESPUÉS de netear.
  const devueltos = new Map<
    string | null,
    { qty: number; refund: number; name: string }
  >();
  for (const p of retornos?.products ?? []) {
    devueltos.set(idStr(p._id), { qty: p.qty, refund: p.refund, name: p.name });
  }
  const topProducts = (ventas?.topProducts ?? [])
    .map((p) => {
      const productId = idStr(p._id);
      const d = devueltos.get(productId);
      return {
        productId,
        name: p.name,
        qty: p.qty - (d?.qty ?? 0),
        revenue: cop(p.revenue - (d?.refund ?? 0)),
        returnedQty: d?.qty ?? 0,
        returned: cop(d?.refund ?? 0),
      };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, TOP_PRODUCTOS);

  // --- Bloque de devoluciones.
  const rt = retornos?.totals?.[0] ?? { amount: 0, tax: 0, count: 0 };
  const returns = {
    count: rt.count,
    amount: cop(rt.amount),
    tax: cop(rt.tax),
    byMethod: (retornos?.byMethod ?? []).map((r) => ({
      method: r._id ?? 'desconocido',
      amount: cop(r.amount),
      count: r.count,
    })),
    byReason: (retornos?.byReason ?? []).map((r) => ({
      reason: r._id ?? 'desconocido',
      amount: cop(r.amount),
      count: r.count,
    })),
    topProducts: (retornos?.products ?? [])
      .slice(0, TOP_PRODUCTOS)
      .map((p) => ({
        productId: idStr(p._id),
        name: p.name,
        qty: p.qty,
        refund: cop(p.refund),
      })),
  };

  // --- Totales.
  const vt = ventas?.totals?.[0] ?? { revenue: 0, tax: 0, tickets: 0 };
  const totalRevenue = cop(vt.revenue - rt.amount);
  return {
    days,
    bySede,
    topProducts,
    returns,
    totalGrossRevenue: cop(vt.revenue),
    totalReturns: cop(rt.amount),
    totalReturnsCount: rt.count,
    totalRevenue,
    totalTax: cop(vt.tax - rt.tax),
    totalTickets: vt.tickets,
    avgTicket: avg(totalRevenue, vt.tickets),
  };
}
