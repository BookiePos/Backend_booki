import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** Insumo de una receta: qué ítem de inventario se consume y cuánto. */
@Schema({ _id: false })
export class BomLine {
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  /** Cantidad por LOTE completo (no por unidad), en la unidad del insumo. */
  @Prop({ required: true, min: 0 })
  qty!: number;

  @Prop({ trim: true })
  note?: string;
}
const BomLineSchema = SchemaFactory.createForClass(BomLine);

export type BillOfMaterialsDocument = HydratedDocument<BillOfMaterials>;

/**
 * Receta de lote (BOM): "con estos insumos salen N unidades de este terminado".
 *
 * NO es la receta del catálogo (`catalog_products.recipe`), y la diferencia
 * importa: aquella descuenta ingredientes en el momento de VENDER un plato;
 * esta describe una FABRICACIÓN previa, que ocurre aunque nadie compre nada ese
 * día. Un panadero hornea de madrugada y vende durante el día: si el consumo se
 * atara a la venta, a las 6 a. m. el inventario mentiría sobre la harina.
 *
 * Las cantidades son por lote, no por unidad: así se escribe una receta real
 * ("un bulto de harina rinde 120 panes") sin arrastrar decimales periódicos que
 * luego no cuadran al multiplicar.
 */
@Schema({ timestamps: true, collection: 'bom_recipes' })
export class BillOfMaterials {
  /**
   * Ítem de inventario que produce esta receta. Único: un terminado tiene una
   * sola receta vigente. Varias versiones de lo mismo obligarían a elegir en
   * cada orden, y en la práctica quien cambia la fórmula edita la que hay.
   */
  @Prop({ type: Types.ObjectId, ref: 'Product', required: true, unique: true })
  productId!: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name!: string;

  /** Unidades del terminado que rinde un lote de esta receta. */
  @Prop({ required: true, min: 0, default: 1 })
  outputQty!: number;

  @Prop({ type: [BomLineSchema], default: [] })
  lines!: BomLine[];

  /**
   * Mano de obra e indirectos del lote (energía, gas, arriendo) en COP entero.
   * Sin él el terminado sale más barato de lo que costó y el margen del POS
   * queda inflado desde el primer día.
   */
  @Prop({ default: 0, min: 0 })
  extraCost!: number;

  /**
   * Empaque del lote escrito EN DINERO, en COP entero.
   *
   * Va aparte de `extraCost` —donde antes se escondía— porque es el costo que
   * más se mueve y el que el dueño negocia por su lado: la bolsa la cambia de
   * proveedor sin que el trabajo de hornear cambie. Mezclados, subir el precio
   * de la bolsa se veía como si la mano de obra hubiera subido.
   *
   * Es dinero y no una línea de insumo a propósito: quien lleva las bolsas en
   * el inventario las pone como insumo y esto se queda en cero; quien no las
   * lleva —lo normal al arrancar— escribe aquí lo que le cuestan y el costo
   * del terminado deja de mentir. Por eso es opcional.
   */
  @Prop({ default: 0, min: 0 })
  packagingCost!: number;

  @Prop({ trim: true })
  note?: string;

  @Prop({ default: true })
  active!: boolean;
}

export const BillOfMaterialsSchema =
  SchemaFactory.createForClass(BillOfMaterials);
