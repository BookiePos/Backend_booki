import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Sede, SedeDocument } from '../infrastructure/schemas/sede.schema';
import { CreateSedeDto } from './dto/create-sede.dto';

@Injectable()
export class SedesService {
  constructor(
    @InjectModel(Sede.name) private readonly sedeModel: Model<SedeDocument>,
  ) {}

  list(): Promise<SedeDocument[]> {
    return this.sedeModel.find().sort({ code: 1 }).exec();
  }

  create(dto: CreateSedeDto): Promise<SedeDocument> {
    return this.sedeModel.create({ ...dto });
  }

  count(): Promise<number> {
    return this.sedeModel.countDocuments().exec();
  }
}
