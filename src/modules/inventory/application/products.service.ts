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
import { CatalogService } from '../../catalog/application/catalog.service';
import {
  Product,
  ProductDocument,
} from '../infrastructure/schemas/product.schema';
import {
  ProductCategory,
  ProductCategoryDocument,
} from '../infrastructure/schemas/product-category.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateProductVariantsDto } from './dto/create-product-variants.dto';
import {
  ImportProductRow,
  ImportProductsResult,
} from './dto/import-products.dto';

/** Producto cartesiano de varias listas: [[S,M],[Rojo,Azul]] → [[S,Rojo],…]. */
function cartesian(lists: string[][]): string[][] {
  return lists.reduce<string[][]>(
    (acc, list) => acc.flatMap((combo) => list.map((v) => [...combo, v])),
    [[]],
  );
}

/** Normaliza un valor de eje para el SKU: mayúsculas, sin tildes ni símbolos. */
function slugToken(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, '');
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductCategory.name)
    private readonly categoryModel: Model<ProductCategoryDocument>,
    // forwardRef: catálogo e inventario se referencian mutuamente. Se usa para
    // reflejar en el POS (catálogo) los ítems con precio de venta.
    @Inject(forwardRef(() => CatalogService))
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Refleja el ítem en el catálogo vendible del POS (mejor esfuerzo). Un fallo
   * aquí no debe tumbar la operación de inventario, así que se traga el error;
   * el ítem queda guardado aunque su vendible no se haya sincronizado.
   */
  private async syncCatalog(product: ProductDocument): Promise<void> {
    try {
      await this.catalog.syncFromInventory(product);
    } catch {
      /* no romper la escritura de inventario si el catálogo falla */
    }
  }

  /** Retira del POS el vendible automático de un ítem eliminado (best-effort). */
  async syncCatalogRemoved(productId: Types.ObjectId | string): Promise<void> {
    try {
      await this.catalog.removeForInventory(productId);
    } catch {
      /* el ítem ya se borró; un fallo aquí no debe propagarse */
    }
  }

  // ─── Productos ─────────────────────────────────────────────────────────────

  list(includeInactive = false): Promise<ProductDocument[]> {
    const filter = includeInactive ? {} : { active: true };
    return this.productModel
      .find(filter)
      .populate('categoryId', 'name')
      .sort({ name: 1 })
      .exec();
  }

  async getOrFail(id: string): Promise<ProductDocument> {
    const product = Types.ObjectId.isValid(id)
      ? await this.productModel.findById(id).exec()
      : null;
    if (!product) throw new NotFoundException('Producto no encontrado');
    return product;
  }

  /** Busca un ítem de inventario por SKU (normalizado). Null si no existe. */
  findBySku(sku: string): Promise<ProductDocument | null> {
    return this.productModel
      .findOne({ sku: sku.trim().toUpperCase() })
      .exec();
  }

  async create(dto: CreateProductDto): Promise<ProductDocument> {
    const sku = dto.sku.trim().toUpperCase();
    const exists = await this.productModel.findOne({ sku }).exec();
    if (exists) {
      throw new ConflictException(`Ya existe un producto con el SKU ${sku}`);
    }
    // Un perecedero siempre controla lotes (necesita fecha de vencimiento).
    // Un montaje también: cada entrada queda registrada como lote.
    const perishable = dto.perishable ?? false;
    const itemType = dto.itemType ?? 'product';
    const trackLots =
      perishable || itemType === 'assembly' ? true : (dto.trackLots ?? false);
    const created = await this.productModel.create({
      ...dto,
      sku,
      itemType,
      perishable,
      trackLots,
      salePrice: dto.salePrice,
      // La fecha de vencimiento solo aplica a perecederos.
      expiresAt: perishable && dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      categoryId: dto.categoryId
        ? new Types.ObjectId(dto.categoryId)
        : undefined,
      supplierId: dto.supplierId
        ? new Types.ObjectId(dto.supplierId)
        : undefined,
    });
    // Si nace con precio de venta, aparece de una vez en el POS.
    await this.syncCatalog(created);
    return created;
  }

  /**
   * Crea un producto retail con variantes: un padre (plantilla, no vendible) y
   * una fila hija por cada combinación de los ejes (producto cartesiano). Cada
   * hija es un Product normal con SKU/stock/precio propios, así que el resto del
   * sistema (stock, catálogo, POS) las trata como cualquier producto.
   */
  async createWithVariants(dto: CreateProductVariantsDto): Promise<{
    parent: ProductDocument;
    variants: ProductDocument[];
  }> {
    const prefix = dto.skuPrefix.trim().toUpperCase();
    if (!prefix) {
      throw new BadRequestException('El SKU base es obligatorio');
    }
    for (const axis of dto.axes) {
      const values = axis.values.map((v) => v.trim()).filter(Boolean);
      if (values.length === 0) {
        throw new BadRequestException(
          `El eje "${axis.name}" necesita al menos un valor`,
        );
      }
      axis.values = values;
    }

    // Combinaciones (producto cartesiano) de los valores de cada eje.
    const combos = cartesian(dto.axes.map((a) => a.values));

    // SKUs a crear: el del padre + uno por combinación. Se validan todos juntos
    // (entre sí y contra la base) antes de crear nada, para no dejar a medias.
    const childSkus = combos.map(
      (combo) => `${prefix}-${combo.map(slugToken).join('-')}`,
    );
    const allSkus = [prefix, ...childSkus];
    const dupInBatch = allSkus.find((s, i) => allSkus.indexOf(s) !== i);
    if (dupInBatch) {
      throw new BadRequestException(
        `Las combinaciones generan SKUs repetidos (${dupInBatch}); ajusta los valores`,
      );
    }
    const clash = await this.productModel
      .findOne({ sku: { $in: allSkus } })
      .exec();
    if (clash) {
      throw new ConflictException(`Ya existe un producto con el SKU ${clash.sku}`);
    }

    const categoryId = dto.categoryId
      ? new Types.ObjectId(dto.categoryId)
      : undefined;
    const supplierId = dto.supplierId
      ? new Types.ObjectId(dto.supplierId)
      : undefined;

    // Padre: plantilla que agrupa las variantes. No lleva precio de venta para
    // no venderse directo; guarda los ejes para la UI.
    const parent = await this.productModel.create({
      sku: prefix,
      itemType: 'product',
      name: dto.name.trim(),
      brand: dto.brand,
      supplier: dto.supplier,
      supplierId,
      description: dto.description,
      categoryId,
      unit: 'und',
      minStock: dto.minStock ?? 0,
      cost: dto.cost ?? 0,
      variantAxes: dto.axes.map((a) => ({ name: a.name, values: a.values })),
    });

    const variants = await Promise.all(
      combos.map((combo, i) => {
        const attrs: Record<string, string> = {};
        dto.axes.forEach((axis, idx) => {
          attrs[axis.name] = combo[idx] ?? '';
        });
        return this.productModel.create({
          sku: childSkus[i],
          itemType: 'product',
          name: `${dto.name.trim()} · ${combo.join(' / ')}`,
          brand: dto.brand,
          supplier: dto.supplier,
          supplierId,
          description: dto.description,
          categoryId,
          unit: 'und',
          minStock: dto.minStock ?? 0,
          cost: dto.cost ?? 0,
          salePrice: dto.salePrice,
          variantOf: parent._id,
          variantAttrs: attrs,
        });
      }),
    );

    // Cada variante con precio entra al POS (el padre-plantilla no se vende).
    for (const v of variants) {
      await this.syncCatalog(v);
    }

    return { parent, variants };
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductDocument> {
    const product = await this.getOrFail(id);

    if (dto.sku) {
      const sku = dto.sku.trim().toUpperCase();
      const clash = await this.productModel
        .findOne({ sku, _id: { $ne: product._id } })
        .exec();
      if (clash) {
        throw new ConflictException(`Ya existe un producto con el SKU ${sku}`);
      }
      product.sku = sku;
    }

    if (dto.categoryId !== undefined) {
      if (dto.categoryId === '') {
        product.categoryId = undefined;
      } else if (Types.ObjectId.isValid(dto.categoryId)) {
        product.categoryId = new Types.ObjectId(dto.categoryId);
      } else {
        throw new BadRequestException('categoryId inválido');
      }
    }

    if (dto.name !== undefined) product.name = dto.name;
    if (dto.brand !== undefined) product.brand = dto.brand;
    if (dto.supplier !== undefined)
      product.supplier = dto.supplier || undefined;
    if (dto.supplierId !== undefined) {
      if (!dto.supplierId) {
        product.supplierId = undefined;
      } else if (Types.ObjectId.isValid(dto.supplierId)) {
        product.supplierId = new Types.ObjectId(dto.supplierId);
      } else {
        throw new BadRequestException('supplierId inválido');
      }
    }
    if (dto.description !== undefined) product.description = dto.description;
    if (dto.unit !== undefined) product.unit = dto.unit;
    if (dto.barcode !== undefined) product.barcode = dto.barcode;
    if (dto.weight !== undefined) product.weight = dto.weight;
    if (dto.shelfLifeDays !== undefined) product.shelfLifeDays = dto.shelfLifeDays;
    if (dto.expiresAt !== undefined) {
      if (dto.expiresAt === '') {
        product.expiresAt = undefined;
      } else {
        const parsed = new Date(dto.expiresAt);
        if (Number.isNaN(parsed.getTime())) {
          throw new BadRequestException('Fecha de vencimiento inválida');
        }
        product.expiresAt = parsed;
      }
    }
    if (dto.minStock !== undefined) product.minStock = dto.minStock;
    if (dto.cost !== undefined) product.cost = dto.cost;
    if (dto.salePrice !== undefined) product.salePrice = dto.salePrice;
    if (dto.active !== undefined) product.active = dto.active;
    if (dto.perishable !== undefined) product.perishable = dto.perishable;
    if (dto.trackLots !== undefined) product.trackLots = dto.trackLots;
    if (dto.itemType !== undefined) product.itemType = dto.itemType;
    // Invariante: perecedero o montaje implica control de lotes.
    if (product.perishable || product.itemType === 'assembly')
      product.trackLots = true;
    // Invariante: la fecha de vencimiento solo aplica a perecederos.
    if (!product.perishable) product.expiresAt = undefined;

    await product.save();
    // Refleja el cambio en el POS: aparece si ganó precio/activo, desaparece si
    // lo perdió, y sincroniza nombre/SKU/categoría/precio del vendible.
    await this.syncCatalog(product);
    return product;
  }

  /**
   * Importa (upsert) un lote de productos desde filas de CSV. Hace match por
   * SKU: si existe lo actualiza con los campos provistos, si no lo crea. La
   * categoría llega por NOMBRE y se resuelve o se crea al vuelo. Cada fila se
   * procesa de forma independiente: un error en una no aborta el resto, se
   * acumula en `errors` con el número de fila (2 = primera fila de datos).
   */
  async importProducts(
    rows: ImportProductRow[],
  ): Promise<ImportProductsResult> {
    const result: ImportProductsResult = {
      total: rows.length,
      created: 0,
      updated: 0,
      errors: [],
    };

    // Índice de categorías por nombre normalizado (se amplía si se crean nuevas).
    const categories = await this.categoryModel.find().exec();
    const catByName = new Map<string, Types.ObjectId>(
      categories.map((c) => [c.name.trim().toLowerCase(), c._id]),
    );

    const resolveCategory = async (
      name?: string,
    ): Promise<Types.ObjectId | undefined> => {
      const clean = name?.trim();
      if (!clean) return undefined;
      const key = clean.toLowerCase();
      const found = catByName.get(key);
      if (found) return found;
      const created = await this.categoryModel.create({ name: clean });
      catByName.set(key, created._id);
      return created._id;
    };

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row) continue;
      const line = i + 2; // fila 1 = encabezado del CSV
      try {
        const sku = row.sku?.trim().toUpperCase();
        if (!sku) throw new Error('Falta el SKU');
        const name = row.name?.trim();

        const categoryId = await resolveCategory(row.category);
        const existing = await this.productModel.findOne({ sku }).exec();

        if (existing) {
          if (name) existing.name = name;
          if (row.itemType !== undefined) existing.itemType = row.itemType;
          if (row.brand !== undefined) existing.brand = row.brand || undefined;
          if (row.supplier !== undefined)
            existing.supplier = row.supplier || undefined;
          if (row.description !== undefined)
            existing.description = row.description || undefined;
          if (categoryId !== undefined) existing.categoryId = categoryId;
          if (row.unit !== undefined && row.unit.trim())
            existing.unit = row.unit.trim();
          if (row.barcode !== undefined)
            existing.barcode = row.barcode || undefined;
          if (row.weight !== undefined) existing.weight = row.weight;
          if (row.perishable !== undefined) existing.perishable = row.perishable;
          if (row.trackLots !== undefined) existing.trackLots = row.trackLots;
          if (row.shelfLifeDays !== undefined)
            existing.shelfLifeDays = row.shelfLifeDays;
          if (row.minStock !== undefined) existing.minStock = row.minStock;
          if (row.cost !== undefined) existing.cost = row.cost;
          if (row.salePrice !== undefined) existing.salePrice = row.salePrice;
          if (row.active !== undefined) existing.active = row.active;
          // Invariantes: perecedero/montaje ⇒ lotes; sin perecedero ⇒ sin venc.
          if (existing.perishable || existing.itemType === 'assembly')
            existing.trackLots = true;
          if (!existing.perishable) existing.expiresAt = undefined;
          await existing.save();
          await this.syncCatalog(existing);
          result.updated += 1;
        } else {
          if (!name) throw new Error('Falta el nombre para crear el producto');
          const perishable = row.perishable ?? false;
          const itemType = row.itemType ?? 'product';
          const trackLots =
            perishable || itemType === 'assembly'
              ? true
              : (row.trackLots ?? false);
          const created = await this.productModel.create({
            sku,
            itemType,
            name,
            brand: row.brand || undefined,
            supplier: row.supplier || undefined,
            description: row.description || undefined,
            categoryId,
            unit: row.unit?.trim() || 'und',
            barcode: row.barcode || undefined,
            weight: row.weight,
            perishable,
            trackLots,
            shelfLifeDays: row.shelfLifeDays,
            minStock: row.minStock ?? 0,
            cost: row.cost ?? 0,
            salePrice: row.salePrice,
            active: row.active ?? true,
          });
          await this.syncCatalog(created);
          result.created += 1;
        }
      } catch (err) {
        result.errors.push({
          row: line,
          sku: row.sku?.trim().toUpperCase() ?? '',
          message: err instanceof Error ? err.message : 'Error desconocido',
        });
      }
    }

    return result;
  }

  // ─── Categorías ────────────────────────────────────────────────────────────

  listCategories(): Promise<ProductCategoryDocument[]> {
    return this.categoryModel.find({ active: true }).sort({ name: 1 }).exec();
  }

  private async getCategoryOrFail(id: string): Promise<ProductCategoryDocument> {
    const category = Types.ObjectId.isValid(id)
      ? await this.categoryModel.findById(id).exec()
      : null;
    if (!category) throw new NotFoundException('Categoría no encontrada');
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<ProductCategoryDocument> {
    const name = dto.name.trim();
    const exists = await this.categoryModel.findOne({ name }).exec();
    if (exists) {
      if (!exists.active) {
        exists.active = true;
        await exists.save();
        return exists;
      }
      throw new ConflictException(`Ya existe la categoría "${name}"`);
    }
    return this.categoryModel.create({ name });
  }

  async updateCategory(
    id: string,
    dto: CreateCategoryDto,
  ): Promise<ProductCategoryDocument> {
    const category = await this.getCategoryOrFail(id);
    const name = dto.name.trim();
    const clash = await this.categoryModel
      .findOne({ name, _id: { $ne: category._id } })
      .exec();
    if (clash) throw new ConflictException(`Ya existe la categoría "${name}"`);
    category.name = name;
    await category.save();
    return category;
  }

  /** Elimina la categoría; si algún ítem la usa, exige reasignarlos antes. */
  async deleteCategory(id: string): Promise<void> {
    const category = await this.getCategoryOrFail(id);
    const inUse = await this.productModel
      .countDocuments({ categoryId: category._id })
      .exec();
    if (inUse > 0) {
      throw new ConflictException(
        `La categoría tiene ${inUse} ítem(s) asignado(s); reasígnalos primero`,
      );
    }
    await category.deleteOne();
  }
}
