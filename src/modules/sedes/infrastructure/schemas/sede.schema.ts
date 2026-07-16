import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SedeDocument = HydratedDocument<Sede>;

@Schema({ timestamps: true, collection: 'sedes' })
export class Sede {
  @Prop({ required: true, unique: true, trim: true })
  code!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ default: true })
  active!: boolean;
}

export const SedeSchema = SchemaFactory.createForClass(Sede);
