import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  CatalogProduct,
  CatalogProductDocument,
} from '../infrastructure/schemas/catalog-product.schema';
import { CreateCatalogProductDto } from './dto/create-catalog-product.dto';
import { UpdateCatalogProductDto } from './dto/update-catalog-product.dto';
import { RecipeLineDto } from './dto/recipe-line.dto';
import { CatalogSourceType } from '../domain/catalog.constants';
import { ProductsService } from '../../inventory/application/products.service';

const PRODUCT_POPULATE = 'name sku unit';

@Injectable()
export class CatalogService {
  constructor(
    @InjectModel(CatalogProduct.name)
    private readonly model: Model<CatalogProductDocument>,
    private readonly inventory: ProductsService,
  ) {}

  list(includeInactive = false): Promise<CatalogProductDocument[]> {
    const filter = includeInactive ? {} : { active: true };
    return this.model
      .find(filter)
      .populate('categoryId', 'name')
      .populate('inventoryProductId', PRODUCT_POPULATE)
      .populate('recipe.productId', PRODUCT_POPULATE)
      .sort({ name: 1 })
      .exec();
  }

  async getOrFail(id: string): Promise<CatalogProductDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model
          .findById(id)
          .populate('categoryId', 'name')
          .populate('inventoryProductId', PRODUCT_POPULATE)
          .populate('recipe.productId', PRODUCT_POPULATE)
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

    const created = await this.model.create({
      sku,
      name: dto.name,
      description: dto.description,
      categoryId: dto.categoryId
        ? new Types.ObjectId(dto.categoryId)
        : undefined,
      salePrice: dto.salePrice,
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
   * Expande un producto vendible en las salidas de inventario que genera
   * (ítem directo o ingredientes de la receta). Lo usará el POS para
   * descontar del inventario cada venta.
   */
  async componentsFor(
    id: string,
    qty: number,
  ): Promise<{ productId: string; qty: number }[]> {
    const product = await this.model.findById(id).exec();
    if (!product) throw new NotFoundException('Producto no encontrado');
    if (product.sourceType === 'inventory') {
      if (!product.inventoryProductId) return [];
      return [
        {
          productId: product.inventoryProductId.toString(),
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
