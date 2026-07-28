import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { RolesService } from './modules/core-auth/application/roles.service';
import { UsersService } from './modules/core-auth/application/users.service';
import { SedesService } from './modules/sedes/application/sedes.service';
import { ROLES } from './modules/core-auth/domain/roles';
import { ALL_PERMISSIONS } from './modules/core-auth/domain/permissions';
import { JwtUser } from './modules/core-auth/infrastructure/jwt.strategy';
import { seedPayroll, recentPeriods } from './seed/payroll.seed';

/**
 * Seeder STANDALONE de nómina: asegura settings del motor, cargos, un roster de
 * empleados y varias corridas mensuales. Idempotente (se puede correr sobre una
 * BD que ya tiene datos, hace "top up" sin duplicar).
 *
 *   npm run seed:payroll
 *
 * Períodos por defecto: los últimos 3 meses. Override con SEED_PAYROLL_PERIODS
 * (coma-separado, ej. "2026-05,2026-06,2026-07").
 */
async function main(): Promise<void> {
  const logger = new Logger('SeedPayroll');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  try {
    const rolesSvc = app.get(RolesService);
    const usersSvc = app.get(UsersService);
    const sedesSvc = app.get(SedesService);

    await rolesSvc.ensureSystemRoles();

    // Sede base: 'centro' si existe, si no la primera, si no la crea.
    const sedes = await sedesSvc.list();
    let sede = sedes.find((s) => s.code === 'centro') ?? sedes[0];
    if (!sede) {
      sede = await sedesSvc.create({ code: 'centro', name: 'Sede Centro' });
    }
    const sedeId = String((sede as { _id: unknown })._id);

    // Actor: el usuario demo si existe, si no uno sintético (solo se usa su email).
    const demo = await usersSvc.findByEmail(
      process.env.SEED_DEMO_EMAIL ?? 'demo@sistemapos.local',
    );
    const owner: JwtUser = {
      userId: demo ? String((demo as { _id: unknown })._id) : 'seed',
      email: demo?.email ?? 'seed@sistemapos.local',
      name: demo?.name ?? 'Seed',
      role: ROLES.OWNER,
      permissions: [...ALL_PERMISSIONS],
      sedeIds: [sedeId],
    };

    const periods = process.env.SEED_PAYROLL_PERIODS
      ? process.env.SEED_PAYROLL_PERIODS.split(',').map((p) => p.trim())
      : recentPeriods(3);

    const result = await seedPayroll(app, { sedeId, owner, periods, logger });

    logger.log('════════════════════════════════════════════════');
    logger.log(' SEED DE NÓMINA COMPLETADO');
    logger.log('════════════════════════════════════════════════');
    logger.log(` Cargos:              ${result.positions}`);
    logger.log(` Empleados nuevos:    ${result.employeesCreated}`);
    logger.log(` Empleados existentes:${result.employeesExisting}`);
    logger.log(` Corridas creadas:    ${result.runsCreated.join(', ') || '—'}`);
    logger.log(` Corridas omitidas:   ${result.runsSkipped.join(', ') || '—'}`);
    logger.log(` Neto última corrida: ${result.lastRunNeto.toLocaleString('es-CO')}`);
    logger.log('════════════════════════════════════════════════');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fallo el seed de nómina:', err);
  process.exit(1);
});
