import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Discount,
  DiscountDocument,
} from '../infrastructure/schemas/discount.schema';
import { CreateDiscountDto } from './dto/create-discount.dto';
import { UpdateDiscountDto } from './dto/update-discount.dto';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';

@Injectable()
export class DiscountsService {
  constructor(
    @InjectModel(Discount.name)
    private readonly model: Model<DiscountDocument>,
  ) {}

  /** Descuentos de una sede (los activos y los inactivos, para la administración). */
  list(sedeId: string, user: JwtUser): Promise<DiscountDocument[]> {
    assertSedeAccess(user, sedeId);
    return this.model
      .find({ sedeId: new Types.ObjectId(sedeId) })
      .sort({ active: -1, name: 1 })
      .exec();
  }

  create(dto: CreateDiscountDto, user: JwtUser): Promise<DiscountDocument> {
    assertSedeAccess(user, dto.sedeId);
    return this.model.create({
      sedeId: new Types.ObjectId(dto.sedeId),
      name: dto.name,
      type: dto.type,
      value: dto.value,
      active: dto.active ?? true,
    });
  }

  async update(
    id: string,
    dto: UpdateDiscountDto,
    user: JwtUser,
  ): Promise<DiscountDocument> {
    const discount = await this.getOrFail(id);
    assertSedeAccess(user, discount.sedeId.toString());
    if (dto.name !== undefined) discount.name = dto.name;
    if (dto.type !== undefined) discount.type = dto.type;
    if (dto.value !== undefined) discount.value = dto.value;
    if (dto.active !== undefined) discount.active = dto.active;
    await discount.save();
    return discount;
  }

  async remove(id: string, user: JwtUser): Promise<{ ok: true }> {
    const discount = await this.getOrFail(id);
    assertSedeAccess(user, discount.sedeId.toString());
    await discount.deleteOne();
    return { ok: true };
  }

  private async getOrFail(id: string): Promise<DiscountDocument> {
    const discount = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!discount) throw new NotFoundException('Descuento no encontrado');
    return discount;
  }
}
