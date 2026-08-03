import { INestApplicationContext } from '@nestjs/common';
import { TenantContext } from '../shared/tenancy/tenant-context';
import { BusinessService } from '../modules/control/application/business.service';
import { DirectoryService } from '../modules/control/application/directory.service';
import {
  BusinessPlan,
  BusinessType,
} from '../modules/control/domain/control.constants';

export interface SeedBusinessConfig {
  /** Nombre comercial de la empresa demo. */
  name: string;
  /** Correo del dueño; identifica la empresa (idempotencia). */
  ownerEmail: string;
  plan: BusinessPlan;
  tipoNegocio: BusinessType;
}

/**
 * Corre un seeder dentro del contexto de una empresa (base `biz_<id>`).
 *
 * En el modelo multi-empresa los seeders ya no escriben en una base única: cada
 * uno apunta a la empresa demo identificada por el correo del dueño. Idempotente
 * —si la empresa ya existe (está en el directorio), la reutiliza; si no, la crea
 * en el control-plane— para que `npm run seed:demo` se pueda repetir.
 */
export async function runInBusiness<T>(
  app: INestApplicationContext,
  config: SeedBusinessConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const businesses = app.get(BusinessService);
  const directory = app.get(DirectoryService);
  const email = config.ownerEmail.toLowerCase();

  const entry = await directory.findByEmail(email);
  const ctx = entry
    ? { businessId: entry.businessId, dbName: entry.dbName }
    : await (async () => {
        const business = await businesses.create({
          name: config.name,
          plan: config.plan,
          tipoNegocio: config.tipoNegocio,
          ownerEmail: email,
        });
        return { businessId: business.id, dbName: business.dbName };
      })();

  return TenantContext.run(ctx, fn);
}
