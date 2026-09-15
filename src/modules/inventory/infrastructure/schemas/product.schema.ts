import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ITEM_TYPES, ItemType } from '../../domain/inventory.constants';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ timestamps: true, collection: 'products' })
export class Product {
  /** Código interno único (SKU). Se normaliza a mayúsculas. */
  @Prop({ required: true, unique: true, trim: true, uppercase: true })
  sku!: string;

  /** Ingrediente (solo compra) o producto (compra + venta). */
  @Prop({ required: true, enum: ITEM_TYPES, default: 'product' })
  itemType!: ItemType;

  /**
   * Es empaque: la bolsa, el vaso, la caja, la cuchara.
   *
   * Va como marca aparte y no como un `itemType` nuevo a propósito. Un empaque
   * se compra, entra por lotes, se cuenta y se merma exactamente igual que un
   * insumo: toda esa maquinaria ya funciona, y meter un cuarto tipo obligaba a
   * cada sitio que mira el tipo (importación, factura por foto, informes) a
   * aprenderse un caso nuevo sin ganar nada. Lo único que cambia de verdad es
   * DÓNDE se administra —su propia sección de Inventario— y que el POS puede
   * ofrecerlo al cobrar.
   */
  @Prop({ default: false })
  isPackaging!: boolean;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true })
  brand?: string;

  /** Proveedor habitual (texto libre; snapshot legible). */
  @Prop({ trim: true })
  supplier?: string;

  /** Referencia al proveedor registrado (opcional; convive con el texto). */
  @Prop({ type: Types.ObjectId, ref: 'Supplier' })
  supplierId?: Types.ObjectId;

  @Prop({ trim: true })
  description?: string;

  @Prop({ type: Types.ObjectId, ref: 'ProductCategory' })
  categoryId?: Types.ObjectId;

  /** Unidad de medida (und, kg, l, paquete...). */
  @Prop({ required: true, trim: true, default: 'und' })
  unit!: string;

  /** Peso/contenido por unidad, expresado en la unidad de medida (p. ej. 500 g). */
  @Prop({ min: 0 })
  weight?: number;

  // ─── Presentación de compra ──────────────────────────────────────────────
  // Cómo ENTRA la mercancía cuando no es como se consume: la harina se consume
  // en gramos pero se compra en bultos de 25 kg. Ver `domain/purchase-unit.ts`.
  // Van juntos o no van; vacíos significan que se compra en la misma `unit` en
  // que se consume, que es como funcionaba todo antes de que esto existiera.

  /** Nombre de la presentación con que llega: bulto, caja, garrafa… */
  @Prop({ trim: true })
  purchaseUnit?: string;

  /** Cuántas `unit` trae una presentación (25000 g en un bulto de 25 kg). */
  @Prop({ min: 0 })
  purchaseFactor?: number;

  @Prop({ trim: true })
  barcode?: string;

  /** Perecedero: exige lote + fecha de vencimiento en las entradas. */
  @Prop({ default: false })
  perishable!: boolean;

  /** Controla existencias por lote (obligatorio si es perecedero). */
  @Prop({ default: false })
  trackLots!: boolean;

  /** Vida útil típica en días (para sugerir vencimiento al recibir). */
  @Prop({ min: 0 })
  shelfLifeDays?: number;

  /** Fecha de vencimiento de referencia (solo perecederos; sugiere el lote). */
  @Prop()
  expiresAt?: Date;

  /** Stock mínimo por defecto (alerta de reposición). */
  @Prop({ default: 0, min: 0 })
  minStock!: number;

  /** Último costo unitario de compra registrado. */
  @Prop({ default: 0, min: 0 })
  cost!: number;

  /** Precio de venta (solo para itemType=product; el POS podrá refinarlo). */
  @Prop({ min: 0 })
  salePrice?: number;

  /**
   * URL pública de la foto (Supabase Storage). Es lo que deja reconocer una
   * bolsa de un vistazo, que es justo lo que nadie hace leyendo "BOL-KRAFT-22":
   * la usa la sección de Empaques y el selector del POS al cobrar.
   */
  @Prop({ trim: true })
  imageUrl?: string;

  /**
   * Ruta del archivo dentro del store. Se guarda además de la URL porque es lo
   * que hace falta para BORRAR el archivo al reemplazar la foto; sin esto cada
   * cambio dejaría el anterior huérfano y ocupando.
   */
  @Prop({ trim: true })
  imagePathname?: string;

  @Prop({ default: true })
  active!: boolean;

  /**
   * Producto en el que se fusionó este duplicado. No se borra: sus ventas y
   * compras pasadas siguen apuntándole, y así se sabe a dónde fue a parar.
   */
  @Prop({ type: Types.ObjectId, ref: 'Product' })
  mergedInto?: Types.ObjectId;

  @Prop()
  mergedAt?: Date;

  // ─── Variantes (retail) ──────────────────────────────────────────────────
  // Cada variante (talla/color…) es su propia fila Product con SKU, barcode,
  // precio y stock propios, agrupada bajo un producto "padre" plantilla. Así se
  // reutiliza toda la maquinaria de inventario/stock/ventas sin cambios.

  /** Producto padre (plantilla) del que esta fila es una variante. */
  @Prop({ type: Types.ObjectId, ref: 'Product' })
  variantOf?: Types.ObjectId;

  /** Valores de los ejes para esta variante, p. ej. { Talla: 'M', Color: 'Rojo' }. */
  @Prop({ type: Object })
  variantAttrs?: Record<string, string>;

  /** Ejes de variación (solo en el padre): describe Talla/Color para la UI. */
  @Prop({
    type: [
      {
        _id: false,
        name: { type: String, required: true },
        values: { type: [String], default: [] },
      },
    ],
    default: undefined,
  })
  variantAxes?: { name: string; values: string[] }[];
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ name: 'text' });
ProductSchema.index({ barcode: 1 }, { sparse: true });
ProductSchema.index({ variantOf: 1 }, { sparse: true });
// La sección de Empaques y el selector del POS filtran por esta marca, y el POS
// la consulta en cada cobro: sin índice sería un recorrido completo por venta.
ProductSchema.index({ isPackaging: 1 }, { sparse: true });
