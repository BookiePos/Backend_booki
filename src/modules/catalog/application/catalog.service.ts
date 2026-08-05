import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProductDocument } from '../../inventory/infrastructure/schemas/product.schema';
import {
  CatalogProduct,
  CatalogProductDocument,
} from '../infrastructure/schemas/catalog-product.schema';
import { CreateCatalogProductDto } from './dto/create-catalog-product.dto';
import { UpdateCatalogProductDto } from './dto/update-catalog-product.dto';
import { RecipeLineDto } from './dto/recipe-line.dto';
import { CatalogSourceType } from '../domain/catalog.constants';
import { ProductsService } from '../../inventory/application/products.service';
import { Product } from '../../inventory/infrastructure/schemas/product.schema';
import { ProductCategory } from '../../inventory/infrastructure/schemas/product-category.schema';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

const PRODUCT_POPULATE = 'name sku unit';

/**
 * Resuelve el id de una referencia que puede estar poblada (documento con `_id`)
 * o venir como `ObjectId`/string. Evita `doc.toString()` sobre un documento
 * poblado, que no devuelve el id.
 */
function refId(ref: unknown): string {
  if (ref && typeof ref === 'object' && '_id' in ref) {
    return String((ref as { _id: unknown })._id);
  }
  return String(ref);
}

@Injectable()
export class CatalogService {
  constructor(
    @InjectModel(CatalogProduct.name)
    private readonly model: Model<CatalogProductDocument>,
    // Modelos referenciados por `populate`. Se pasan EXPLÍCITOS a populate para
    // que mongoose no dependa de que el modelo por ref ("Product",
    // "ProductCategory") ya esté compilado en la conexión del tenant activo
    // (si no lo estaba, lanzaba MissingSchemaError al entrar directo al POS).
    @InjectModel(Product.name)
    private readonly productModel: Model<unknown>,
    @InjectModel(ProductCategory.name)
    private readonly categoryModel: Model<unknown>,
    // forwardRef: inventario y catálogo se referencian mutuamente (el inventario
    // llama a `syncFromInventory` al guardar un ítem con precio).
    @Inject(forwardRef(() => ProductsService))
    private readonly inventory: ProductsService,
  ) {}

  list(includeInactive = false): Promise<CatalogProductDocument[]> {
    const filter = includeInactive ? {} : { active: true };
    return this.model
      .find(filter)
      .populate({ path: 'categoryId', select: 'name', model: this.categoryModel })
      .populate({ path: 'inventoryProductId', select: PRODUCT_POPULATE, model: this.productModel })
      .populate({ path: 'recipe.productId', select: PRODUCT_POPULATE, model: this.productModel })
      .sort({ name: 1 })
      .exec();
  }

  async getOrFail(id: string): Promise<CatalogProductDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model
          .findById(id)
          .populate({ path: 'categoryId', select: 'name', model: this.categoryModel })
          .populate({ path: 'inventoryProductId', select: PRODUCT_POPULATE, model: this.productModel })
          .populate({ path: 'recipe.productId', select: PRODUCT_POPULATE, model: this.productModel })
          .exec()
      : null;
    if (!doc) throw new NotFoundException('Producto no encontrado');
    return doc;
  }

  async create(dto: CreateCatalogProductDto): Promise<CatalogProductDocument> {
    const source = await this.resolveSource(
      dto.sourceType,
      dto.inventoryProductId,
      dto.qtyPerUnit,
      dto.recipe,
    );

    // El SKU de un producto "del inventario" lo manda el ítem vinculado
    // (fuente única de verdad); el de una receta lo define el usuario.
    const { sku: derivedSku, ...sourceFields } = source;
    const sku = (derivedSku ?? dto.sku).trim().toUpperCase();
    const exists = await this.model.findOne({ sku }).exec();
    if (exists) {
      throw new ConflictException(`Ya existe un producto con el SKU ${sku}`);
    }
    // En una receta el SKU lo escribe el usuario: no debe chocar con el de un
    // ítem de inventario (los productos "del inventario" sí lo comparten a
    // propósito, por eso solo se valida cuando no viene heredado).
    if (!derivedSku) {
      await this.ensureSkuFreeInInventory(sku);
    }

    const created = await this.model.create({
      sku,
      name: dto.name,
      description: dto.description,
      categoryId: dto.categoryId
        ? new Types.ObjectId(dto.categoryId)
        : undefined,
      salePrice: dto.salePrice,
      ivaRate: dto.ivaRate ?? 19,
      ivaType: dto.ivaType ?? 'gravado',
      active: dto.active ?? true,
      ...sourceFields,
    });
    return this.getOrFail(created.id);
  }

  async update(
    id: string,
    dto: UpdateCatalogProductDto,
  ): Promise<CatalogProductDocument> {
    const product = await this.model.findById(id).exec();
    if (!product) throw new NotFoundException('Producto no encontrado');

    if (dto.name !== undefined) product.name = dto.name;
    if (dto.description !== undefined)
      product.description = dto.description || undefined;
    if (dto.salePrice !== undefined) product.salePrice = dto.salePrice;
    if (dto.ivaRate !== undefined) product.ivaRate = dto.ivaRate;
    if (dto.ivaType !== undefined) product.ivaType = dto.ivaType;
    if (dto.active !== undefined) product.active = dto.active;

    if (dto.categoryId !== undefined) {
      if (dto.categoryId === '') {
        product.categoryId = undefined;
      } else if (Types.ObjectId.isValid(dto.categoryId)) {
        product.categoryId = new Types.ObjectId(dto.categoryId);
      } else {
        throw new BadRequestException('categoryId inválido');
      }
    }

    // Si cambia la fuente (o sus datos), se revalida y se normaliza el otro
    // bloque para que no queden datos incoherentes de la fuente anterior.
    const sourceType = dto.sourceType ?? product.sourceType;
    const touchesSource =
      dto.sourceType !== undefined ||
      dto.inventoryProductId !== undefined ||
      dto.qtyPerUnit !== undefined ||
      dto.recipe !== undefined;
    let derivedSku: string | undefined;
    if (touchesSource) {
      const source = await this.resolveSource(
        sourceType,
        dto.inventoryProductId ??
          product.inventoryProductId?.toString() ??
          undefined,
        dto.qtyPerUnit ?? product.qtyPerUnit,
        dto.recipe ??
          product.recipe.map((l) => ({
            productId: l.productId.toString(),
            qty: l.qty,
          })),
      );
      product.sourceType = source.sourceType;
      product.inventoryProductId = source.inventoryProductId;
      product.qtyPerUnit = source.qtyPerUnit;
      product.recipe = source.recipe;
      derivedSku = source.sku;
    }

    // SKU: en modo inventario queda atado al del ítem vinculado; en receta lo
    // define el usuario. Se ignora dto.sku para productos del inventario.
    const nextSku =
      product.sourceType === 'inventory' ? derivedSku : dto.sku;
    if (nextSku) {
      const sku = nextSku.trim().toUpperCase();
      if (sku !== product.sku) {
        const clash = await this.model
          .findOne({ sku, _id: { $ne: product._id } })
          .exec();
        if (clash) {
          throw new ConflictException(
            `Ya existe un producto con el SKU ${sku}`,
          );
        }
        // Igual que al crear: el SKU de una receta no puede pisar un ítem de
        // inventario (en modo inventario el SKU viene heredado, no se valida).
        if (product.sourceType !== 'inventory') {
          await this.ensureSkuFreeInInventory(sku);
        }
        product.sku = sku;
      }
    }

    await product.save();
    return this.getOrFail(product.id);
  }

  async remove(id: string): Promise<void> {
    const product = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!product) throw new NotFoundException('Producto no encontrado');
    await product.deleteOne();
  }

  /**
   * Catálogo vendible del POS: activo y con precio de venta. Puebla el ítem de
   * inventario vinculado (sku + barcode) para que el POS pueda emparejar por
   * código de barras al escanear.
   */
  listSellable(): Promise<CatalogProductDocument[]> {
    return this.model
      .find({ active: true, salePrice: { $gt: 0 } })
      .populate({ path: 'categoryId', select: 'name', model: this.categoryModel })
      .populate({ path: 'inventoryProductId', select: 'sku barcode', model: this.productModel })
      .sort({ name: 1 })
      .exec();
  }

  /**
   * Carga un producto de catálogo asegurando que se puede vender (activo y con
   * precio). Lo usa el POS al registrar la venta (precio siempre del servidor).
   */
  async loadSellableOrFail(id: string): Promise<CatalogProductDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!doc) throw new NotFoundException('Producto no encontrado');
    if (!doc.active || !doc.salePrice || doc.salePrice <= 0) {
      throw new BadRequestException(
        `${doc.name} no está disponible para la venta`,
      );
    }
    return doc;
  }

  /**
   * Expande un producto vendible en las salidas de inventario que genera
   * (ítem directo o ingredientes de la receta), sin ir a la BD. Lo usa el POS
   * para calcular disponibilidad y descontar del inventario en cada venta.
   */
  componentsOf(
    product: CatalogProductDocument,
    qty = 1,
  ): { productId: string; qty: number }[] {
    if (product.sourceType === 'inventory') {
      if (!product.inventoryProductId) return [];
      return [
        {
          // `inventoryProductId` puede venir poblado (listSellable) o como
          // ObjectId (loadSellableOrFail): en ambos casos se resuelve el id.
          productId: refId(product.inventoryProductId),
          qty: (product.qtyPerUnit ?? 1) * qty,
        },
      ];
    }
    return product.recipe.map((line) => ({
      productId: line.productId.toString(),
      qty: line.qty * qty,
    }));
  }

  /**
   * Código de barras del ítem de inventario vinculado (solo productos de fuente
   * inventario y solo si `inventoryProductId` viene poblado, p. ej. desde
   * `listSellable`). Lo usa el POS para escanear. Las recetas no tienen barcode.
   */
  barcodeOf(product: CatalogProductDocument): string | null {
    if (product.sourceType !== 'inventory') return null;
    const ref = product.inventoryProductId as unknown as
      | { barcode?: string }
      | null
      | undefined;
    return ref?.barcode ?? null;
  }

  /** Versión que carga el producto por id (para usos puntuales). */
  async componentsFor(
    id: string,
    qty: number,
  ): Promise<{ productId: string; qty: number }[]> {
    const product = await this.model.findById(id).exec();
    if (!product) throw new NotFoundException('Producto no encontrado');
    return this.componentsOf(product, qty);
  }

  /**
   * Valida y normaliza los campos según la fuente elegida. Devuelve el bloque
   * de campos listo para persistir, con el otro bloque vaciado.
   */
  private async resolveSource(
    sourceType: CatalogSourceType,
    inventoryProductId: string | undefined,
    qtyPerUnit: number | undefined,
    recipe: RecipeLineDto[] | undefined,
  ): Promise<{
    sourceType: CatalogSourceType;
    inventoryProductId?: Types.ObjectId;
    qtyPerUnit?: number;
    recipe: { productId: Types.ObjectId; qty: number }[];
    /** SKU heredado del ítem de inventario (solo en modo inventario). */
    sku?: string;
  }> {
    // Un negocio retail no maneja productos con receta (se refuerza aquí, más
    // allá de la UI, por si la petición llega directo por API). El giro viaja en
    // el contexto de tenant (claim `biztype` del token).
    if (sourceType === 'recipe' && TenantContext.current()?.tipoNegocio === 'retail') {
      throw new BadRequestException(
        'Un negocio retail no maneja productos con receta',
      );
    }

    if (sourceType === 'inventory') {
      if (!inventoryProductId) {
        throw new BadRequestException(
          'Selecciona el ítem de inventario que se venderá',
        );
      }
      const item = await this.loadInventoryItemOrFail(inventoryProductId);
      return {
        sourceType,
        inventoryProductId: new Types.ObjectId(inventoryProductId),
        qtyPerUnit: qtyPerUnit && qtyPerUnit > 0 ? qtyPerUnit : 1,
        recipe: [],
        sku: item.sku,
      };
    }

    // sourceType === 'recipe'
    const lines = this.mergeRecipe(recipe ?? []);
    if (lines.length === 0) {
      throw new BadRequestException('Agrega al menos un ingrediente a la receta');
    }
    for (const line of lines) {
      await this.loadInventoryItemOrFail(line.productId.toString());
    }
    return { sourceType, qtyPerUnit: undefined, recipe: lines };
  }

  /** Suma cantidades de ingredientes repetidos para no dejar líneas dobles. */
  private mergeRecipe(
    recipe: RecipeLineDto[],
  ): { productId: Types.ObjectId; qty: number }[] {
    const byProduct = new Map<string, number>();
    for (const line of recipe) {
      byProduct.set(
        line.productId,
        (byProduct.get(line.productId) ?? 0) + line.qty,
      );
    }
    return [...byProduct.entries()].map(([productId, qty]) => ({
      productId: new Types.ObjectId(productId),
      qty,
    }));
  }

  /**
   * Impide que el SKU de una receta reutilice el de un ítem de inventario.
   * (Los productos vinculados a inventario sí lo comparten a propósito.)
   */
  private async ensureSkuFreeInInventory(sku: string): Promise<void> {
    const invItem = await this.inventory.findBySku(sku);
    if (invItem) {
      throw new ConflictException(
        `El SKU ${sku} ya pertenece a un ítem de inventario`,
      );
    }
  }

  /**
   * Sincroniza el vendible del POS que corresponde a un ítem de inventario.
   *
   * Un ítem de inventario **vendible** (itemType `product`, activo, con
   * `salePrice > 0` y que no sea el padre-plantilla de variantes) aparece solo
   * en el POS: aquí se crea/actualiza su producto de catálogo "automático"
   * (fuente inventario, 1 unidad de stock por venta). Si deja de ser vendible
   * (sin precio, inactivo o pasa a ingrediente), se elimina.
   *
   * Solo toca los vendibles automáticos (`autoFromInventory: true`): los que el
   * usuario creó a mano en /productos (precio, receta o IVA propios) no se
   * pisan, y si ya existe uno manual para este ítem, no se duplica.
   */
  async syncFromInventory(product: ProductDocument): Promise<void> {
    const productId = product._id as Types.ObjectId;
    const price = product.salePrice ?? 0;
    const isParent = Boolean(
      product.variantAxes && product.variantAxes.length > 0,
    );
    const sellable =
      product.itemType === 'product' && product.active && price > 0 && !isParent;

    const existingAuto = await this.model
      .findOne({ inventoryProductId: productId, autoFromInventory: true })
      .exec();

    if (!sellable) {
      // Dejó de ser vendible: se retira del POS (las ventas ya guardan su propio
      // snapshot, así que borrar el vendible no afecta el histórico).
      if (existingAuto) await existingAuto.deleteOne();
      return;
    }

    const sku = product.sku.trim().toUpperCase();

    if (existingAuto) {
      existingAuto.sku = sku;
      existingAuto.name = product.name;
      existingAuto.categoryId = product.categoryId;
      existingAuto.salePrice = price;
      existingAuto.sourceType = 'inventory';
      existingAuto.inventoryProductId = productId;
      existingAuto.qtyPerUnit = 1;
      existingAuto.active = true;
      await existingAuto.save();
      return;
    }

    // No dupliques un vendible que el usuario ya creó a mano para este ítem o
    // que ya usa este SKU (el índice de SKU es único, además).
    const manual = await this.model
      .findOne({
        autoFromInventory: { $ne: true },
        $or: [{ inventoryProductId: productId }, { sku }],
      })
      .exec();
    if (manual) return;

    await this.model.create({
      sku,
      name: product.name,
      categoryId: product.categoryId,
      salePrice: price,
      ivaRate: 19,
      ivaType: 'gravado',
      sourceType: 'inventory',
      inventoryProductId: productId,
      qtyPerUnit: 1,
      recipe: [],
      active: true,
      autoFromInventory: true,
    });
  }

  /**
   * Retira del POS el vendible automático de un ítem de inventario que se
   * eliminó. Solo borra el automático; un vendible manual (o una receta que use
   * el ítem) es responsabilidad del usuario.
   */
  async removeForInventory(productId: Types.ObjectId | string): Promise<void> {
    const id =
      typeof productId === 'string' ? new Types.ObjectId(productId) : productId;
    await this.model
      .deleteMany({ inventoryProductId: id, autoFromInventory: true })
      .exec();
  }

  /** Carga el ítem de inventario (para heredar su SKU) o lanza 400 claro. */
  private async loadInventoryItemOrFail(id: string): Promise<{ sku: string }> {
    try {
      return await this.inventory.getOrFail(id);
    } catch {
      throw new BadRequestException(
        'Uno de los ítems de inventario no existe o fue eliminado',
      );
    }
  }
}
