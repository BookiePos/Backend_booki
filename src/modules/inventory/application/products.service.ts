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
    const perishable = dto.perishable ?? false;
    const trackLots = perishable ? true : (dto.trackLots ?? false);
    const itemType = dto.itemType ?? 'product';
    return this.productModel.create({
      ...dto,
      sku,
      itemType,
      perishable,
      trackLots,
      // Un ingrediente no se vende: no lleva precio de venta.
      salePrice: itemType === 'ingredient' ? undefined : dto.salePrice,
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
    if (dto.description !== undefined) product.description = dto.description;
    if (dto.unit !== undefined) product.unit = dto.unit;
    if (dto.barcode !== undefined) product.barcode = dto.barcode;
    if (dto.weight !== undefined) product.weight = dto.weight;
    if (dto.shelfLifeDays !== undefined) product.shelfLifeDays = dto.shelfLifeDays;
    if (dto.minStock !== undefined) product.minStock = dto.minStock;
    if (dto.cost !== undefined) product.cost = dto.cost;
    if (dto.salePrice !== undefined) product.salePrice = dto.salePrice;
    if (dto.active !== undefined) product.active = dto.active;
    if (dto.perishable !== undefined) product.perishable = dto.perishable;
    if (dto.trackLots !== undefined) product.trackLots = dto.trackLots;
    if (dto.itemType !== undefined) product.itemType = dto.itemType;
    // Invariante: perecedero implica control de lotes.
    if (product.perishable) product.trackLots = true;
    // Invariante: un ingrediente no lleva precio de venta.
    if (product.itemType === 'ingredient') product.salePrice = undefined;

    await product.save();
    return product;
  }

  // ─── Categorías ────────────────────────────────────────────────────────────

  listCategories(): Promise<ProductCategoryDocument[]> {
    return this.categoryModel.find({ active: true }).sort({ name: 1 }).exec();
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

  async deleteCategory(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Categoría no encontrada');
    }
    const category = await this.categoryModel.findById(id).exec();
    if (!category) throw new NotFoundException('Categoría no encontrada');
    const inUse = await this.productModel
      .countDocuments({ categoryId: category._id, active: true })
      .exec();
    if (inUse > 0) {
      throw new ConflictException(
        `La categoría tiene ${inUse} producto(s) activo(s); reasígnalos primero`,
      );
    }
    category.active = false;
    await category.save();
  }
}
