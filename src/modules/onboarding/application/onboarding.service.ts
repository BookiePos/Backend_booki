import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CatalogProduct } from '../../catalog/infrastructure/schemas/catalog-product.schema';
import { allowedSedeIds, assertSedeAccess } from '../../core-auth/domain/sede-access';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { ProductsService } from '../../inventory/application/products.service';
import { StockService } from '../../inventory/application/stock.service';
import { Product } from '../../inventory/infrastructure/schemas/product.schema';
import { ProductCategory } from '../../inventory/infrastructure/schemas/product-category.schema';
import { RestaurantService } from '../../restaurant/application/restaurant.service';
import { SedesService } from '../../sedes/application/sedes.service';
import type { BusinessType } from '../../control/domain/control.constants';
import {
  PLANTILLAS,
  STOCK_INICIAL,
  fiscalDe,
  itemsDe,
  plantillaDe,
  type Plantilla,
} from '../domain/plantillas';
import type { AplicarPlantillaDto } from './dto/aplicar-plantilla.dto';

export interface ResumenPlantilla {
  tipo: string;
  nombre: string;
  descripcion: string;
  productos: number;
  categorias: number;
  mesas: number;
  ejemplos: string[];
  /** Cuántos de sus productos ya están cargados en la empresa. */
  cargados: number;
}

export interface EstadoOnboarding {
  tipoNegocio: BusinessType | null;
  /** Productos que la empresa tiene y que NO vienen de una plantilla. */
  productosPropios: number;
  plantillas: ResumenPlantilla[];
}

export interface ResultadoPlantilla {
  tipo: string;
  sedeId: string;
  categorias: { creadas: number; existentes: number };
  productos: { creados: number; omitidos: number };
  mesas: { creadas: number; omitidas: number };
  /** Qué cobrará la venta de lo recién creado, según el giro y el perfil fiscal. */
  impuestos: { conInc: number; conIva: number; excluidos: number };
  stockInicial: number;
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const skuDe = (p: Plantilla): RegExp => new RegExp(`^PL-${escapar(p.prefijo)}-`);

/** Sí, ya existía: la carrera entre dos clics o un reintento no es un error. */
function esDuplicado(err: unknown): boolean {
  return (
    err instanceof ConflictException ||
    (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000)
  );
}

/**
 * Primera venta en minutos (ítem 6.6): carga un menú o catálogo de ejemplo por
 * tipo de negocio. NO reimplementa nada: crea con los mismos servicios que usan
 * las pantallas (`ProductsService`, `CatalogService`, `StockService`,
 * `RestaurantService`), así que el SKU único, el kardex y las reglas de
 * catálogo valen igual.
 *
 * - Idempotente: cada ítem tiene un SKU estable `PL-<prefijo>-NN`; lo que ya
 *   existe se salta y aplicar dos veces no duplica nada. Un fallo a medias se
 *   completa reintentando.
 * - No pisa lo propio: si la empresa ya tiene productos que no son de esta
 *   plantilla, rechaza salvo `confirmar: true`.
 * - El impuesto sale del giro de la empresa. En un restaurante lo servido nace
 *   como expendio (sin IVA): el INC lo pone la venta con el perfil fiscal de la
 *   sede (`saleTaxFor`), no se escribe aquí.
 *
 * Todo corre dentro del contexto del tenant de la request: los modelos son
 * proxies de la base `biz_<id>` (ver `dbNameForBusiness`).
 */
@Injectable()
export class OnboardingService {
  constructor(
    @InjectModel(CatalogProduct.name)
    private readonly catalogModel: Model<CatalogProduct>,
    @InjectModel(Product.name)
    private readonly productModel: Model<Product>,
    @InjectModel(ProductCategory.name)
    private readonly categoryModel: Model<ProductCategory>,
    private readonly catalog: CatalogService,
    private readonly products: ProductsService,
    private readonly stock: StockService,
    private readonly restaurant: RestaurantService,
    private readonly sedes: SedesService,
  ) {}

  private noEsPlantilla(): Record<string, unknown> {
    return { sku: { $not: /^PL-[A-Z]+-\d+$/ } };
  }

  private async propios(plantilla?: Plantilla): Promise<number> {
    const filtro = plantilla
      ? { sku: { $not: skuDe(plantilla) } }
      : this.noEsPlantilla();
    const [enCatalogo, enInventario] = await Promise.all([
      this.catalogModel.countDocuments(filtro).exec(),
      this.productModel.countDocuments(filtro).exec(),
    ]);
    return Math.max(enCatalogo, enInventario);
  }

  async estado(): Promise<EstadoOnboarding> {
    const plantillas = await Promise.all(
      PLANTILLAS.map(async (p): Promise<ResumenPlantilla> => {
        const items = itemsDe(p);
        return {
          tipo: p.tipo,
          nombre: p.nombre,
          descripcion: p.descripcion,
          productos: items.length,
          categorias: p.categorias.length,
          mesas: p.mesas?.cantidad ?? 0,
          ejemplos: items.slice(0, 3).map((i) => i.nombre),
          cargados: await this.catalogModel.countDocuments({ sku: skuDe(p) }).exec(),
        };
      }),
    );
    return {
      tipoNegocio: TenantContext.current()?.tipoNegocio ?? null,
      productosPropios: await this.propios(),
      plantillas,
    };
  }

  async aplicar(dto: AplicarPlantillaDto, user: JwtUser): Promise<ResultadoPlantilla> {
    const plantilla = plantillaDe(dto.tipo);
    if (!plantilla) throw new BadRequestException('Tipo de plantilla desconocido');

    // El giro decide el impuesto; sin él se adivinaría mal en un restaurante.
    const giro = TenantContext.current()?.tipoNegocio ?? user.tipoNegocio;
    if (!giro) {
      throw new BadRequestException(
        'No pudimos saber el tipo de tu negocio. Cierra sesión, vuelve a entrar e inténtalo de nuevo.',
      );
    }

    const sedeId = await this.resolverSede(dto.sedeId, user);

    if (!dto.confirmar && (await this.propios(plantilla)) > 0) {
      throw new ConflictException(
        'Tu negocio ya tiene productos. Si igual quieres sumar el catálogo de ejemplo, confirma que no reemplaza lo que ya tienes.',
      );
    }

    const categorias = { creadas: 0, existentes: 0 };
    const idCategoria = new Map<string, string>();
    for (const c of plantilla.categorias) {
      const { id, creada } = await this.categoria(c.nombre);
      idCategoria.set(c.nombre, id);
      if (creada) categorias.creadas++;
      else categorias.existentes++;
    }

    const productos = { creados: 0, omitidos: 0 };
    const impuestos = { conInc: 0, conIva: 0, excluidos: 0 };
    for (const item of itemsDe(plantilla)) {
      const yaVendible = await this.catalogModel.exists({ sku: item.sku }).exec();
      if (yaVendible) {
        productos.omitidos++;
        continue;
      }
      try {
        const fiscal = fiscalDe(item, giro);
        const categoryId = idCategoria.get(item.categoria);
        // Se crea sin precio: con precio, el inventario publicaría solo un
        // vendible a IVA 19 y aquí hace falta el impuesto correcto del giro.
        let inv = await this.productModel.findOne({ sku: item.sku }).exec();
        if (!inv) {
          inv = await this.products.create({
            sku: item.sku,
            name: item.nombre,
            unit: 'und',
            cost: item.costo,
            categoryId,
          });
          await this.stock.entry(
            {
              productId: String(inv._id),
              sedeId,
              qty: STOCK_INICIAL,
              unitCost: item.costo,
              note: 'Existencias de ejemplo de la plantilla',
            },
            user,
          );
        }
        await this.catalog.create({
          sku: item.sku,
          name: item.nombre,
          categoryId,
          salePrice: item.precio,
          ivaRate: fiscal.ivaRate,
          ivaType: fiscal.ivaType,
          tratamientoFiscal: fiscal.tratamientoFiscal,
          sourceType: 'inventory',
          inventoryProductId: String(inv._id),
          qtyPerUnit: 1,
        });
        productos.creados++;
        if (fiscal.efecto === 'inc') impuestos.conInc++;
        else if (fiscal.efecto === 'iva') impuestos.conIva++;
        else impuestos.excluidos++;
      } catch (err) {
        if (!esDuplicado(err)) throw err;
        productos.omitidos++;
      }
    }

    const mesas = await this.mesas(plantilla, sedeId, user);
    return {
      tipo: plantilla.tipo,
      sedeId,
      categorias,
      productos,
      mesas,
      impuestos,
      stockInicial: STOCK_INICIAL,
    };
  }

  private async resolverSede(pedida: string | undefined, user: JwtUser): Promise<string> {
    if (pedida) {
      assertSedeAccess(user, pedida);
      await this.sedes.findOrFail(pedida);
      return pedida;
    }
    const [primera] = await this.sedes.list(allowedSedeIds(user));
    if (!primera) {
      throw new BadRequestException('Crea una sede antes de cargar el catálogo de ejemplo');
    }
    return String(primera._id);
  }

  private async categoria(nombre: string): Promise<{ id: string; creada: boolean }> {
    const existente = await this.categoryModel.findOne({ name: nombre }).exec();
    if (existente) {
      if (!existente.active) {
        existente.active = true;
        await existente.save();
      }
      return { id: String(existente._id), creada: false };
    }
    try {
      const nueva = await this.categoryModel.create({ name: nombre });
      return { id: String(nueva._id), creada: true };
    } catch (err) {
      if (!esDuplicado(err)) throw err;
      const ganadora = await this.categoryModel.findOne({ name: nombre }).exec();
      if (!ganadora) throw err;
      return { id: String(ganadora._id), creada: false };
    }
  }

  private async mesas(
    plantilla: Plantilla,
    sedeId: string,
    user: JwtUser,
  ): Promise<{ creadas: number; omitidas: number }> {
    if (!plantilla.mesas) return { creadas: 0, omitidas: 0 };
    const { cantidad, zona, puestos } = plantilla.mesas;
    const hechas = new Set(
      (await this.restaurant.listTables(user, sedeId)).map((t) => `${t.zone}|${t.name}`),
    );
    let creadas = 0;
    let omitidas = 0;
    for (let n = 1; n <= cantidad; n++) {
      const name = `Mesa ${n}`;
      if (hechas.has(`${zona}|${name}`)) {
        omitidas++;
        continue;
      }
      await this.restaurant.createTable({ sedeId, name, zone: zona, seats: puestos }, user);
      creadas++;
    }
    return { creadas, omitidas };
  }
}
