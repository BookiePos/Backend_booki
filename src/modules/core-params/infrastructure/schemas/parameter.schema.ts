import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  PARAM_GROUPS,
  PARAM_VALUE_TYPES,
  ParamGroup,
  ParamValueType,
} from '../../domain/params.constants';

export type ParameterDocument = HydratedDocument<Parameter>;

/**
 * Una versión (vigencia) de un parámetro. La combinación `key + effectiveFrom`
 * es única: cada cambio abre una vigencia nueva, nunca se edita el valor de una
 * versión ya publicada (histórico inmutable). El valor "vigente" se resuelve en
 * el servicio tomando la versión con `effectiveFrom` más reciente y <= hoy.
 */
@Schema({ timestamps: true, collection: 'core_parameters' })
export class Parameter {
  @Prop({ required: true, trim: true })
  key!: string;

  @Prop({ required: true, trim: true })
  label!: string;

  @Prop({ required: true, enum: PARAM_GROUPS })
  group!: ParamGroup;

  @Prop({ required: true, enum: PARAM_VALUE_TYPES })
  valueType!: ParamValueType;

  /** Valor de la vigencia. Number/percent/money → número; text → string; boolean → bool. */
  @Prop({ type: Object, required: true })
  value!: number | string | boolean;

  /**
   * Override por sede (opcional). Si está vacío, el parámetro es GLOBAL de la
   * empresa. Si trae una sede, es una excepción para esa sede: `resolve()`
   * prefiere la versión de la sede y, si no hay, cae a la global. Así una sede
   * puede tener, p. ej., su propio redondeo o tolerancia de caja.
   */
  @Prop({ type: String, trim: true, default: null })
  sedeId?: string | null;

  @Prop({ trim: true })
  unit?: string;

  /** Fecha de inicio de vigencia (YYYY-MM-DD). */
  @Prop({ required: true })
  effectiveFrom!: string;

  @Prop({ trim: true })
  note?: string;

  /** Sembrado por el sistema (no se puede borrar la clave, sí versionar). */
  @Prop({ default: false })
  system!: boolean;

  @Prop({ trim: true })
  createdByEmail?: string;
}

export const ParameterSchema = SchemaFactory.createForClass(Parameter);

// Una sola versión por clave, alcance (sede/global) y fecha de vigencia. El
// `sedeId` en la llave permite que una sede tenga su propio override sin chocar
// con la versión global (sedeId null). El índice legacy `key_1_effectiveFrom_1`
// se descarta en `ParamsService.ensureSchema()`.
ParameterSchema.index(
  { key: 1, sedeId: 1, effectiveFrom: 1 },
  { unique: true },
);
ParameterSchema.index({ group: 1 });
