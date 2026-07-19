import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { UsersService } from './modules/core-auth/application/users.service';
import { RolesService } from './modules/core-auth/application/roles.service';
import { SedesService } from './modules/sedes/application/sedes.service';
import { SuppliersService } from './modules/suppliers/application/suppliers.service';
import { ROLES } from './modules/core-auth/domain/roles';

/** Proveedores de ejemplo para arrancar (restaurante colombiano). */
const SEED_SUPPLIERS = [
  {
    name: 'Distribuidora La Cosecha S.A.S.',
    docType: 'NIT' as const,
    docNumber: '901234567',
    phone: '3101234567',
    contactName: 'Marta Rodríguez',
    city: 'Bogotá',
    category: 'Frutas y verduras',
  },
  {
    name: 'Carnes El Novillo',
    docType: 'NIT' as const,
    docNumber: '900876543',
    phone: '3157654321',
    contactName: 'Jorge Peña',
    city: 'Bogotá',
    category: 'Cárnicos',
  },
  {
    name: 'Lácteos San Fernando',
    docType: 'NIT' as const,
    docNumber: '830456789',
    phone: '3209876543',
    city: 'Chía',
    category: 'Lácteos',
  },
  {
    name: 'Abarrotes Don José',
    docType: 'CC' as const,
    docNumber: '79456123',
    phone: '3114567890',
    contactName: 'José Martínez',
    city: 'Bogotá',
    category: 'Abarrotes',
  },
  {
    name: 'Desechables y Aseo El Punto',
    docType: 'NIT' as const,
    docNumber: '901987654',
    phone: '3182345678',
    city: 'Bogotá',
    category: 'Desechables y aseo',
  },
];

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
    const suppliers = app.get(SuppliersService);

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

    // Proveedores de ejemplo, sin duplicar (clave: docType + docNumber).
    const existingSuppliers = await suppliers.list(true);
    const byDoc = new Set(
      existingSuppliers.map((s) => `${s.docType}:${s.docNumber}`),
    );
    for (const s of SEED_SUPPLIERS) {
      if (byDoc.has(`${s.docType}:${s.docNumber}`)) {
        logger.log(`Proveedor existente: ${s.name}`);
        continue;
      }
      await suppliers.create(s);
      logger.log(`Proveedor creado: ${s.name}`);
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
