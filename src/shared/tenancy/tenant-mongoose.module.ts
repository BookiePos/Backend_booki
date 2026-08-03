import { DynamicModule, Module, Provider } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Schema } from 'mongoose';
import { TenantModelRegistry } from './tenant-model.registry';
import { createModelProxy } from './model-proxy';

export interface TenantModelDefinition {
  name: string;
  schema: Schema;
}

/**
 * Reemplaza a `MongooseModule.forFeature` para las colecciones de negocio.
 *
 * Registra, bajo el MISMO token que usa `@InjectModel(X.name)`
 * (`getModelToken(name)` → `"XModel"`), un provider singleton que devuelve un
 * Proxy de modelo. En cada llamada el Proxy resuelve el modelo real sobre la
 * base de datos de la empresa activa. Por eso NINGÚN `@InjectModel` existente
 * necesita cambios: siguen inyectando el mismo token, ahora multi-empresa.
 */
@Module({})
export class TenantMongooseModule {
  static forFeature(definitions: TenantModelDefinition[]): DynamicModule {
    const providers: Provider[] = definitions.map((def) => ({
      provide: getModelToken(def.name),
      useFactory: (registry: TenantModelRegistry) =>
        createModelProxy(() => registry.modelFor(def.name, def.schema)),
      inject: [TenantModelRegistry],
    }));

    return {
      module: TenantMongooseModule,
      providers,
      exports: providers,
    };
  }
}
