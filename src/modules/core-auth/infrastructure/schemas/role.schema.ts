import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RoleDocument = HydratedDocument<Role>;

/**
 * Rol persistido. La `key` es un slug único (p.ej. "cajero-tarde"); el `name`
 * es el nombre visible. Los roles de sistema (`isSystem`) no se pueden borrar.
 */
@Schema({ timestamps: true, collection: 'roles' })
export class Role {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  key!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ type: [String], default: [] })
  permissions!: string[];

  @Prop({ default: false })
  isSystem!: boolean;

  /**
   * Alguien editó a mano los permisos de este rol de sistema.
   *
   * Mientras es `false`, los permisos de Dueño y Administrador se leen del
   * CÓDIGO y no de esta fila: así una función nueva le llega sola a todos los
   * dueños al desplegar, sin migración ni semilla, que era el motivo de tener
   * esos dos roles bloqueados.
   *
   * En cuanto alguien los edita pasa a `true` y manda la fila para siempre. Es
   * la única forma de que el dueño pueda recortar a su Administrador —que es lo
   * que pidió— sin que el despliegue siguiente le deshaga el cambio en
   * silencio. El precio, dicho donde se ve: un rol tocado a mano ya no recibe
   * las capacidades nuevas solo, y hay que dárselas cuando salgan.
   */
  @Prop({ default: false })
  permissionsCustomized!: boolean;
}

export const RoleSchema = SchemaFactory.createForClass(Role);
