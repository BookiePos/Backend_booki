import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { StockLot } from '../../inventory/infrastructure/schemas/stock-lot.schema';
import { StockMovement } from '../../inventory/infrastructure/schemas/stock-movement.schema';
import { Product } from '../../inventory/infrastructure/schemas/product.schema';
import { Sale } from '../../sales/infrastructure/schemas/sale.schema';
import { ProductionOrder } from '../../production/infrastructure/schemas/production-order.schema';
import { orderNumberFromNote } from '../../production/domain/production.constants';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { allowedSedeIds } from '../../core-auth/domain/sede-access';

/** A quién le llegó: lo que la venta guardó del cliente. */
export interface TraceCustomer {
  name?: string;
  idNumber?: string;
  phone?: string;
  email?: string;
}

export interface TraceSale {
  saleId: string;
  saleNumber: string;
  date: string;
  status: string;
  /** Unidades de ESTE lote que salieron en esa venta. */
  qty: number;
  customer: TraceCustomer | null;
}

export interface TraceLotNode {
  lotId: string;
  lotCode: string;
  productId: string;
  productName: string;
  expiresAt: string | null;
  receivedAt: string;
  initialQty: number;
  remainingQty: number;
  supplier: string | null;
  /** Ventas que se llevaron parte de este lote. */
  sales: TraceSale[];
  /** Órdenes de producción que lo consumieron, con lo que salió de ellas. */
  producedInto: TraceProductionNode[];
}

export interface TraceProductionNode {
  orderId: string;
  number: string;
  date: string;
  productName: string;
  producedQty: number;
  /** Lotes del terminado que salió, ya rastreados a su vez. */
  outputs: TraceLotNode[];
}

export interface TraceResult extends TraceLotNode {
  /** Cuántas unidades del lote se alcanzaron a vender, sumando la cadena. */
  soldQty: number;
  /** Clientes distintos que la recibieron, por documento o por nombre. */
  customers: TraceCustomer[];
  /** Si la cadena se cortó por el tope de saltos (ver `MAX_DEPTH`). */
  truncated: boolean;
}

/**
 * Tope de saltos por producción.
 *
 * Harina → masa → galleta son dos saltos, y es la cadena más larga que se ve en
 * la práctica. El tope está para que una receta que se refiera a sí misma por
 * error no deje la consulta dando vueltas; si se alcanza, se avisa en vez de
 * devolver una respuesta incompleta como si fuera completa.
 */
const MAX_DEPTH = 3;

/**
 * Trazabilidad hacia adelante: "el lote L-2409 salió malo, ¿a dónde se fue?".
 *
 * Es la pregunta que hace el INVIMA y la que hay que poder responder en una
 * hora, no en una tarde. Todo el dato ya estaba guardado y repartido en tres
 * sitios; esto solo lo junta:
 *
 * - Cada venta anotó de qué lotes descontó (`components.consumedLots`).
 * - Cada consumo de producción dejó su movimiento en el kárdex con el número
 *   de la orden en la nota.
 * - Cada orden terminada ingresó su terminado con su propio lote.
 *
 * Así que de un lote de harina se llega a las tandas donde entró, de ahí a los
 * lotes de galleta que salieron, y de ahí a las ventas y a sus clientes.
 *
 * No escribe nada: es solo lectura.
 */
@Injectable()
export class TraceabilityService {
  constructor(
    @InjectModel(StockLot.name)
    private readonly lotModel: Model<StockLot>,
    @InjectModel(StockMovement.name)
    private readonly movementModel: Model<StockMovement>,
    @InjectModel(Product.name)
    private readonly productModel: Model<Product>,
    @InjectModel(Sale.name)
    private readonly saleModel: Model<Sale>,
    @InjectModel(ProductionOrder.name)
    private readonly orderModel: Model<ProductionOrder>,
  ) {}

  /**
   * Busca lotes por código para poder escribir "L-2409" y encontrarlo.
   *
   * El código no es único entre productos —dos proveedores pueden usar la
   * misma numeración— así que puede devolver varios y quien pregunta elige.
   */
  async findLots(code: string, user: JwtUser) {
    const texto = code.trim();
    if (!texto) return [];
    const sedes = allowedSedeIds(user);
    const filtro: Record<string, unknown> = {
      lotCode: { $regex: texto, $options: 'i' },
    };
    if (sedes) {
      filtro.sedeId = { $in: sedes.map((s) => new Types.ObjectId(s)) };
    }
    const lotes = await this.lotModel
      .find(filtro)
      .sort({ receivedAt: -1 })
      .limit(50)
      .exec();
    const nombres = await this.productNames(
      lotes.map((l) => l.productId.toString()),
    );
    return lotes.map((l) => ({
      lotId: (l as unknown as { _id: Types.ObjectId })._id.toString(),
      lotCode: l.lotCode,
      productId: l.productId.toString(),
      productName: nombres.get(l.productId.toString()) ?? 'Producto eliminado',
      expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
      receivedAt: l.receivedAt.toISOString(),
      remainingQty: l.qty,
      supplier: l.supplier ?? null,
    }));
  }

  private async productNames(ids: string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids)];
    if (unicos.length === 0) return new Map();
    const docs = await this.productModel
      .find({ _id: { $in: unicos.map((id) => new Types.ObjectId(id)) } })
      .select('_id name')
      .exec();
    return new Map(
      docs.map((d) => [
        (d as unknown as { _id: Types.ObjectId })._id.toString(),
        d.name,
      ]),
    );
  }

  /** Rastrea un lote y todo lo que salió de él. */
  async traceLot(lotId: string, user: JwtUser): Promise<TraceResult> {
    if (!Types.ObjectId.isValid(lotId)) {
      throw new NotFoundException('Lote no encontrado');
    }
    const truncado = { valor: false };
    const visitados = new Set<string>();
    const raiz = await this.buildNode(lotId, user, 0, visitados, truncado);
    if (!raiz) throw new NotFoundException('Lote no encontrado');

    // El resumen se arma recorriendo el árbol entero: lo que importa no es lo
    // que salió en el primer salto, sino a cuánta gente le llegó al final.
    const ventas: TraceSale[] = [];
    const recorrer = (nodo: TraceLotNode) => {
      ventas.push(...nodo.sales);
      for (const p of nodo.producedInto) p.outputs.forEach(recorrer);
    };
    recorrer(raiz);

    const porCliente = new Map<string, TraceCustomer>();
    for (const v of ventas) {
      if (!v.customer) continue;
      // Un cliente de mostrador no deja documento: se agrupa por nombre para
      // no contar tres veces a la misma persona, y si no hay ni nombre se
      // cuenta aparte porque de verdad no se sabe quién fue.
      const clave =
        v.customer.idNumber?.trim() ||
        v.customer.name?.trim().toLowerCase() ||
        `anonimo:${v.saleId}`;
      if (!porCliente.has(clave)) porCliente.set(clave, v.customer);
    }

    return {
      ...raiz,
      soldQty: ventas.reduce((s, v) => s + v.qty, 0),
      customers: [...porCliente.values()],
      truncated: truncado.valor,
    };
  }

  private async buildNode(
    lotId: string,
    user: JwtUser,
    depth: number,
    visitados: Set<string>,
    truncado: { valor: boolean },
  ): Promise<TraceLotNode | null> {
    if (visitados.has(lotId)) return null;
    visitados.add(lotId);

    const lot = await this.lotModel.findById(lotId).exec();
    if (!lot) return null;
    const nombres = await this.productNames([lot.productId.toString()]);

    const nodo: TraceLotNode = {
      lotId,
      lotCode: lot.lotCode,
      productId: lot.productId.toString(),
      productName:
        nombres.get(lot.productId.toString()) ?? 'Producto eliminado',
      expiresAt: lot.expiresAt ? lot.expiresAt.toISOString() : null,
      receivedAt: lot.receivedAt.toISOString(),
      initialQty: lot.initialQty,
      remainingQty: lot.qty,
      supplier: lot.supplier ?? null,
      sales: await this.salesOfLot(lotId, user),
      producedInto: [],
    };

    if (depth >= MAX_DEPTH) {
      truncado.valor = true;
      return nodo;
    }
    nodo.producedInto = await this.productionFromLot(
      lotId,
      user,
      depth,
      visitados,
      truncado,
    );
    return nodo;
  }

  /** Ventas que descontaron de este lote, con lo que se llevaron. */
  private async salesOfLot(lotId: string, user: JwtUser): Promise<TraceSale[]> {
    const sedes = allowedSedeIds(user);
    const oid = new Types.ObjectId(lotId);
    const filtro: Record<string, unknown> = {
      'components.consumedLots.lotId': oid,
    };
    if (sedes) {
      filtro.sedeId = { $in: sedes.map((s) => new Types.ObjectId(s)) };
    }
    const ventas = await this.saleModel
      .find(filtro)
      .sort({ createdAt: -1 })
      .limit(500)
      .exec();

    return ventas.map((v) => {
      // Cuánto de ESTE lote salió en esta venta: puede haber descontado de
      // varios a la vez (FEFO reparte cuando un lote no alcanza).
      let qty = 0;
      for (const c of v.components ?? []) {
        for (const cl of c.consumedLots ?? []) {
          if (cl.lotId?.toString() === lotId) qty += cl.qty;
        }
      }
      const doc = v as unknown as {
        _id: Types.ObjectId;
        createdAt?: Date;
      };
      const cliente = v.customer as TraceCustomer | undefined;
      return {
        saleId: doc._id.toString(),
        saleNumber: v.saleNumber,
        date: (doc.createdAt ?? new Date()).toISOString(),
        status: v.status,
        qty,
        customer:
          cliente && (cliente.name || cliente.idNumber || cliente.phone)
            ? cliente
            : null,
      };
    });
  }

  /**
   * Órdenes de producción que consumieron el lote, y qué salió de ellas.
   *
   * El enlace es la nota que producción deja en el kárdex con el número de la
   * orden (`productionNote`). El terminado se busca por el `lotCode` que la
   * orden registró, que es el lote que entró al cerrarla.
   */
  private async productionFromLot(
    lotId: string,
    user: JwtUser,
    depth: number,
    visitados: Set<string>,
    truncado: { valor: boolean },
  ): Promise<TraceProductionNode[]> {
    const salidas = await this.movementModel
      .find({ lotId: new Types.ObjectId(lotId), type: 'production_out' })
      .select('note')
      .exec();

    const numeros = [
      ...new Set(
        salidas
          .map((m) => orderNumberFromNote(m.note))
          .filter((n): n is string => Boolean(n)),
      ),
    ];
    if (numeros.length === 0) return [];

    const ordenes = await this.orderModel
      .find({ number: { $in: numeros } })
      .exec();

    const nodos: TraceProductionNode[] = [];
    for (const orden of ordenes) {
      const doc = orden as unknown as { _id: Types.ObjectId };
      const outputs: TraceLotNode[] = [];
      if (orden.lotCode) {
        const producidos = await this.lotModel
          .find({ productId: orden.productId, lotCode: orden.lotCode })
          .select('_id')
          .exec();
        for (const p of producidos) {
          const hijo = await this.buildNode(
            (p as unknown as { _id: Types.ObjectId })._id.toString(),
            user,
            depth + 1,
            visitados,
            truncado,
          );
          if (hijo) outputs.push(hijo);
        }
      }
      nodos.push({
        orderId: doc._id.toString(),
        number: orden.number,
        date: orden.date,
        productName: orden.productName,
        producedQty: orden.producedQty,
        outputs,
      });
    }
    return nodos;
  }
}
