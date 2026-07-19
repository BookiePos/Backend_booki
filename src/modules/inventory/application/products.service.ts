import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductCategory.name)
    private readonly categoryModel: Model<ProductCategoryDocument>,
  ) {}

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
    return this.productModel.create({
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
    });
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
    return product;
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
