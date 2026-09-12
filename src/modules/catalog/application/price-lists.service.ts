import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PriceList,
  PriceListDocument,
} from '../infrastructure/schemas/price-list.schema';
import {
  CatalogProduct,
  CatalogProductDocument,
} from '../infrastructure/schemas/catalog-product.schema';
import {
  CreatePriceListDto,
  UpdatePriceListDto,
} from './dto/price-list.dto';
import { PriceListRules, resolveUnitPrice } from '../domain/price-list';

/**
 * Listas de precios: mayorista, detal, distribuidor.
 *
 * Guarda las reglas; quién las resuelve es `domain/price-list.ts`, que no sabe
 * de Mongo y por eso se puede probar sola. Este servicio es el único que las
 * lee desde la base.
 *
 * La comanda del restaurante NO pasa por aquí y no hace falta: sus precios son
 * un acumulado en pantalla, y la cuenta definitiva la arma `SalesService`
 * releyendo el catálogo, que sí aplica la lista.
 */
@Injectable()
export class PriceListsService {
  constructor(
    @InjectModel(PriceList.name)
    private readonly model: Model<PriceListDocument>,
    @InjectModel(CatalogProduct.name)
    private readonly catalogModel: Model<CatalogProductDocument>,
  ) {}

  list(includeInactive = false): Promise<PriceListDocument[]> {
    const filter = includeInactive ? {} : { active: true };
    return this.model.find(filter).sort({ name: 1 }).exec();
  }

  async getOrFail(id: string): Promise<PriceListDocument> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!doc) throw new NotFoundException('Lista de precios no encontrada');
    return doc;
  }

  /**
   * Valida que los productos de la lista existan y que no haya dos escalones
   * con la misma cantidad mínima para el mismo producto.
   *
   * Lo segundo no rompe nada —`pickTier` desempata por el precio más barato—
   * pero casi siempre es que alguien quiso corregir un precio y terminó
   * agregando otro renglón, así que se avisa en vez de dejarlo pasar.
   */
  private async assertItems(items: CreatePriceListDto['items']): Promise<void> {
    if (!items || items.length === 0) return;

    const ids = [...new Set(items.map((i) => i.catalogProductId))];
    const found = await this.catalogModel
      .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('_id')
      .exec();
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'La lista tiene precios de productos que ya no existen en el catálogo',
      );
    }

    const vistos = new Set<string>();
    for (const item of items) {
      const clave = `${item.catalogProductId}:${item.minQty ?? 0}`;
      if (vistos.has(clave)) {
        throw new BadRequestException(
          'Hay dos precios para el mismo producto con la misma cantidad mínima',
        );
      }
      vistos.add(clave);
    }
  }

  async create(dto: CreatePriceListDto): Promise<PriceListDocument> {
    await this.assertItems(dto.items);
    return this.model.create({
      name: dto.name.trim(),
      description: dto.description?.trim() || undefined,
      discountPercent: dto.discountPercent ?? 0,
      items: (dto.items ?? []).map((i) => ({
        catalogProductId: new Types.ObjectId(i.catalogProductId),
        price: i.price,
        minQty: i.minQty,
      })),
      active: dto.active ?? true,
    });
  }

  async update(
    id: string,
    dto: UpdatePriceListDto,
  ): Promise<PriceListDocument> {
    const doc = await this.getOrFail(id);
    if (dto.items !== undefined) await this.assertItems(dto.items);

    if (dto.name !== undefined) doc.name = dto.name.trim();
    if (dto.description !== undefined)
      doc.description = dto.description.trim() || undefined;
    if (dto.discountPercent !== undefined)
      doc.discountPercent = dto.discountPercent;
    if (dto.items !== undefined) {
      doc.items = dto.items.map((i) => ({
        catalogProductId: new Types.ObjectId(i.catalogProductId),
        price: i.price,
        minQty: i.minQty,
      }));
    }
    if (dto.active !== undefined) doc.active = dto.active;

    await doc.save();
    return doc;
  }

  /**
   * Se desactiva en vez de borrarse: las ventas viejas guardan el precio que
   * cobraron, pero los clientes siguen apuntando a la lista y un borrado
   * dejaría esa referencia colgando.
   */
  async deactivate(id: string): Promise<{ ok: boolean }> {
    const doc = await this.getOrFail(id);
    doc.active = false;
    await doc.save();
    return { ok: true };
  }

  /**
   * Reglas de una lista, listas para `resolveUnitPrice`. Devuelve `null`
   * cuando no hay lista o está desactivada: el precio de mostrador.
   *
   * Una lista desactivada NO se aplica aunque el cliente la tenga asignada.
   * Es la forma de dejar de vender a mayorista sin tener que editar cliente
   * por cliente.
   */
  async rulesFor(id?: string | null): Promise<PriceListRules | null> {
    if (!id || !Types.ObjectId.isValid(id)) return null;
    const doc = await this.model.findById(id).exec();
    if (!doc || !doc.active) return null;
    return {
      discountPercent: doc.discountPercent,
      items: doc.items.map((i) => ({
        catalogProductId: i.catalogProductId.toString(),
        price: i.price,
        minQty: i.minQty,
      })),
    };
  }

  /**
   * Vista previa de cómo quedaría el catálogo con una lista: lo usa la
   * pantalla para mostrar "mostrador $3.000 · mayorista $2.640" sin que cada
   * cliente tenga que repetir la cuenta a mano.
   */
  async preview(
    id: string,
    qty = 1,
  ): Promise<
    { catalogProductId: string; name: string; base: number; price: number }[]
  > {
    const rules = await this.rulesFor(id);
    const products = await this.catalogModel
      .find({ active: true })
      .select('_id name salePrice')
      .sort({ name: 1 })
      .exec();
    return products.map((p) => ({
      catalogProductId: p._id.toString(),
      name: p.name,
      base: p.salePrice,
      price: resolveUnitPrice({
        basePrice: p.salePrice,
        qty,
        catalogProductId: p._id.toString(),
        list: rules,
      }),
    }));
  }
}
