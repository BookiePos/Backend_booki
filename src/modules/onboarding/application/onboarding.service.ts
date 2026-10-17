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
  REGEX_SKU_PLANTILLA,
  STOCK_INICIAL,
  fiscalDe,
  itemsDe,
  motivoNoAplica,
  plantillaDe,
  seSiembra,
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
  /**
   * Productos que cargarla SUMARÍA a algo ajeno (propios u otras plantillas).
   * Con `ajenos > 0` hace falta `confirmar`; es lo mismo que decide el 409.
   */
  ajenos: number;
  /** Si aplica al giro de la empresa; si no, `motivo` dice por qué. */
  aplica: boolean;
  motivo: string | null;
}

export interface EstadoOnboarding {
  tipoNegocio: BusinessType | null;
  /** Productos que la empresa tiene y que NO vienen de ninguna plantilla. */
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
  /** Unidades de ejemplo por producto: sin costo y fuera de la valorización. */
  stockInicial: number;
  /** Ítems que no se sembraron por el giro (lo servido en una empresa retail). */
  omitidosPorGiro: number;
  aviso?: string;
}

export interface ResultadoQuitar {
  vendiblesQuitados: number;
  inventarioDesactivado: number;
  /** Con compras o ajustes reales: se conservan. */
  conservados: number;
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const skuDe = (p: Plantilla): RegExp => new RegExp(`^PL-${escapar(p.prefijo)}-\\d{2}$`);

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

  /**
   * Productos que NO son de `plantilla` (o de ninguna, si no se indica). Un SKU
   * `PL-XYZ-01` escrito a mano no cuenta como de plantilla: solo los prefijos
   * conocidos.
   */
  private async propios(plantilla?: Plantilla): Promise<number> {
    const filtro = {
      sku: { $not: plantilla ? skuDe(plantilla) : REGEX_SKU_PLANTILLA },
    };
    const [enCatalogo, enInventario] = await Promise.all([
      this.catalogModel.countDocuments(filtro).exec(),
      this.productModel.countDocuments(filtro).exec(),
    ]);
    return Math.max(enCatalogo, enInventario);
  }

  async estado(): Promise<EstadoOnboarding> {
    const giro = TenantContext.current()?.tipoNegocio ?? null;
    const plantillas = await Promise.all(
      PLANTILLAS.map(async (p): Promise<ResumenPlantilla> => {
        const items = itemsDe(p);
        const motivo = giro ? motivoNoAplica(p.tipo, giro) : null;
        return {
          tipo: p.tipo,
          nombre: p.nombre,
          descripcion: p.descripcion,
          productos: items.length,
          categorias: p.categorias.length,
          mesas: p.mesas?.cantidad ?? 0,
          ejemplos: items.slice(0, 3).map((i) => i.nombre),
          cargados: await this.catalogModel.countDocuments({ sku: skuDe(p) }).exec(),
          ajenos: await this.propios(p),
          aplica: motivo === null,
          motivo,
        };
      }),
    );
    return {
      tipoNegocio: giro,
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

    // En retail lo servido quedaría con IVA 19 en vez de INC: no se siembra.
    const noAplica = motivoNoAplica(plantilla.tipo, giro);
    if (noAplica) throw new BadRequestException(noAplica);

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
    let omitidosPorGiro = 0;
    for (const item of itemsDe(plantilla)) {
      if (!seSiembra(item, giro)) {
        omitidosPorGiro++;
        continue;
      }
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
          // Sin costo: la plantilla no sabe cuánto le cuesta a esta persona.
          inv = await this.products.create({
            sku: item.sku,
            name: item.nombre,
            unit: 'und',
            categoryId,
          });
        } else if (!inv.active) {
          // Quedó desactivado por «quitar datos de ejemplo»: se reutiliza.
          inv.active = true;
          await inv.save();
        }
        // Existencias de ejemplo SIN costo (movimiento `sample`), nunca una
        // compra: no hay asiento ni valorización. Solo si aún no tiene stock.
        await this.stock.sembrarMuestra(
          { productId: String(inv._id), sedeId, qty: STOCK_INICIAL },
          user,
        );
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
      omitidosPorGiro,
      aviso:
        omitidosPorGiro > 0
          ? `No se cargaron ${omitidosPorGiro} ítem(s) servidos: van con un negocio de tipo restaurante.`
          : undefined,
    };
  }

  /**
   * «Quitar datos de ejemplo»: retira los vendibles de la plantilla, desactiva
   * sus ítems de inventario y borra las existencias de ejemplo. Lo que ya tuvo
   * compras o ajustes reales se conserva. Las mesas y categorías no se tocan
   * (pueden tener comandas); se borran desde su pantalla.
   */
  async quitar(tipo: string): Promise<ResultadoQuitar> {
    const plantilla = plantillaDe(tipo);
    if (!plantilla) throw new BadRequestException('Tipo de plantilla desconocido');
    const skus = itemsDe(plantilla).map((i) => i.sku);

    const inventario = await this.productModel.find({ sku: { $in: skus } }).exec();
    const limpios = new Set(
      await this.stock.quitarMuestras(inventario.map((p) => String(p._id))),
    );

    let vendiblesQuitados = 0;
    for (const sku of skus) {
      const v = await this.catalogModel.findOne({ sku }).exec();
      const inv = inventario.find((p) => p.sku === sku);
      // Un vendible cuyo inventario ya es real (compras) lo decide la persona.
      if (!v || (inv && !limpios.has(String(inv._id)))) continue;
      await this.catalog.remove(String(v._id));
      vendiblesQuitados++;
    }
    let inventarioDesactivado = 0;
    for (const p of inventario) {
      if (!limpios.has(String(p._id)) || !p.active) continue;
      p.active = false;
      await p.save();
      inventarioDesactivado++;
    }
    return {
      vendiblesQuitados,
      inventarioDesactivado,
      conservados: inventario.length - limpios.size,
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
