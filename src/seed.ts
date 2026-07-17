import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { UsersService } from './modules/core-auth/application/users.service';
import { RolesService } from './modules/core-auth/application/roles.service';
import { SedesService } from './modules/sedes/application/sedes.service';
import { ROLES } from './modules/core-auth/domain/roles';

/**
 * Siembra datos mínimos para arrancar: una sede por defecto y un usuario admin.
 * Requiere MongoDB disponible. Idempotente (no duplica si ya existen).
 */
async function seed(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  try {
    const sedes = app.get(SedesService);
    const users = app.get(UsersService);
    const roles = app.get(RolesService);

    // Roles de sistema (owner/admin/manager/cashier) en la colección `roles`.
    await roles.ensureSystemRoles();
    logger.log('Roles de sistema asegurados.');

    let sede = (await sedes.list())[0];
    if (!sede) {
      sede = await sedes.create({
        code: process.env.DEFAULT_SEDE ?? 'centro',
        name: 'Sede Centro',
      });
      logger.log(`Sede creada: ${sede.code}`);
    } else {
      logger.log(`Sede existente: ${sede.code}`);
    }

    const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@erp.local';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
    const existing = await users.findByEmail(adminEmail);
    if (!existing) {
      await users.create({
        email: adminEmail,
        password: adminPassword,
        name: 'Administrador',
        role: ROLES.OWNER,
        sedeIds: [sede.id],
      });
      logger.log(`Admin (Dueño) creado: ${adminEmail} / ${adminPassword}`);
    } else if (existing.role !== ROLES.OWNER) {
      // Migración idempotente: el admin previo pasa a ser Dueño.
      await users.update(existing.id, { role: ROLES.OWNER });
      logger.log(`Admin migrado a Dueño: ${adminEmail}`);
    } else {
      logger.log(`Admin (Dueño) ya existe: ${adminEmail}`);
    }

    logger.log('Seed completado.');
  } finally {
    await app.close();
  }
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fallo el seed:', err);
  process.exit(1);
});
