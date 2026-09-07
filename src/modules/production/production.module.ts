import { Module } from '@nestjs/common';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CatalogModule } from '../catalog/catalog.module';
import {
  BillOfMaterials,
  BillOfMaterialsSchema,
} from './infrastructure/schemas/bill-of-materials.schema';
import {
  ProductionOrder,
  ProductionOrderSchema,
} from './infrastructure/schemas/production-order.schema';
import {
  Counter,
  CounterSchema,
} from '../sales/infrastructure/schemas/counter.schema';
import { ProductionService } from './application/production.service';
import { ProductionController } from './infrastructure/production.controller';

/**
 * Producción: transforma insumos en terminados.
 *
 * Es el intermediario de ALGUNOS productos, no de todos:
 *
 *   Inventario ──────────────────────────────────────────► Productos
 *        └──────────────► Producción ─────────────────────────┘
 *
 * Lo que se compra ya hecho va derecho de Inventario a Productos y no pasa por
 * aquí. Lo que se fabrica sale de insumos del inventario, se convierte en un
 * terminado con su lote y su costo, y desde ahí se publica como vendible.
 *
 * Producción depende de Inventario y Catálogo, y NUNCA al revés. Es lo que los
 * mantiene ignorantes de las recetas: quien lleva el stock no tiene por qué
 * saber que algo se fabrica, solo que entró o salió.
 */
@Module({
  imports: [
    InventoryModule,
    // El catálogo vendible es el otro extremo del puente: producción consulta
    // si el terminado ya se vende y puede publicarlo.
    CatalogModule,
    TenantMongooseModule.forFeature([
      { name: BillOfMaterials.name, schema: BillOfMaterialsSchema },
      { name: ProductionOrder.name, schema: ProductionOrderSchema },
      // Consecutivo OP-000001 sobre la colección de contadores compartida.
      { name: Counter.name, schema: CounterSchema },
    ]),
  ],
  controllers: [ProductionController],
  providers: [ProductionService],
  exports: [ProductionService],
})
export class ProductionModule {}
