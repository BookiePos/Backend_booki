import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Sale, SaleDocument } from '../infrastructure/schemas/sale.schema';
import { CatalogService } from '../../catalog/application/catalog.service';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  Sugerencia,
  VentaConEmpaque,
  sugerirEmpaque,
} from '../domain/packaging-suggestion';

/**
 * Cuántas ventas pasadas se miran para aprender. Suficientes para que una
 * costumbre se note y pocas como para que la consulta no pese en cada cobro:
 * el POS la llama al abrir la pantalla de pago y ahí no se puede esperar.
 */
const VENTAS_A_MIRAR = 400;

/** Hasta dónde hacia atrás. Más allá, la costumbre ya no es la de ahora. */
const DIAS_DE_MEMORIA = 90;

/**
 * Qué empaque proponerle a quien cobra.
 *
 * La regla de decisión vive en `domain/packaging-suggestion.ts`, sin Mongo;
 * esto solo va a buscar los datos que esa regla necesita.
 */
@Injectable()
export class PackagingService {
  constructor(
    @InjectModel(Sale.name)
    private readonly saleModel: Model<SaleDocument>,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Sugerencia para el carrito que se está cobrando.
   *
   * Solo aprende de ventas con `packagingExplicit`: en las demás la lista está
   * vacía porque nadie pudo elegir, no porque la venta saliera sin empaque, y
   * confundir las dos cosas haría que el sistema "aprendiera" a no proponer
   * nada justo con lo que más se vendió antes de esta versión.
   */
  async sugerir(
    sedeId: string,
    lines: { productId: string; qty: number }[],
    user: JwtUser,
  ): Promise<Sugerencia> {
    assertSedeAccess(user, sedeId);
    const cartProductIds = lines.map((l) => l.productId);
    if (cartProductIds.length === 0) {
      return { lineas: [], origen: 'ninguno', apoyo: 0 };
    }

    const desde = new Date(Date.now() - DIAS_DE_MEMORIA * 24 * 60 * 60 * 1000);
    const ventas = await this.saleModel
      .find({
        sedeId: new Types.ObjectId(sedeId),
        status: 'completed',
        packagingExplicit: true,
        createdAt: { $gte: desde },
      })
      .select('lines.productId packaging createdAt')
      .sort({ createdAt: -1 })
      .limit(VENTAS_A_MIRAR)
      .lean()
      .exec();

    const historial: VentaConEmpaque[] = ventas.map((venta) => ({
      productIds: (venta.lines ?? []).map((l) => l.productId.toString()),
      packaging: (venta.packaging ?? []).map((p) => ({
        productId: p.productId.toString(),
        name: p.name,
        qty: p.qty,
      })),
      soldAt: (venta as { createdAt?: Date }).createdAt ?? desde,
    }));

    const semilla = await this.catalog.packagingSeedFor(lines);
    return sugerirEmpaque(cartProductIds, historial, semilla);
  }
}
