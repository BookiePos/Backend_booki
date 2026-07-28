import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { UsersService } from './modules/core-auth/application/users.service';
import { RolesService } from './modules/core-auth/application/roles.service';
import { SedesService } from './modules/sedes/application/sedes.service';
import { SuppliersService } from './modules/suppliers/application/suppliers.service';
import { ProductsService } from './modules/inventory/application/products.service';
import { StockService } from './modules/inventory/application/stock.service';
import { CatalogService } from './modules/catalog/application/catalog.service';
import { CajaService } from './modules/caja/application/caja.service';
import { SalesService } from './modules/sales/application/sales.service';
import { FinanceService } from './modules/finance/application/finance.service';
import { PurchasingService } from './modules/purchasing/application/purchasing.service';
import { RestaurantService } from './modules/restaurant/application/restaurant.service';
import { EmployeesService } from './modules/employees/application/employees.service';
import { PositionsService } from './modules/employees/application/positions.service';
import { PayrollService } from './modules/payroll/application/payroll.service';
import { TaxService } from './modules/core-tax/application/tax.service';
import { ParamsService } from './modules/core-params/application/params.service';
import { LedgerService } from './modules/core-ledger/application/ledger.service';
import { AuditService } from './modules/core-audit/application/audit.service';
import { ROLES } from './modules/core-auth/domain/roles';
import { ALL_PERMISSIONS } from './modules/core-auth/domain/permissions';
import { JwtUser } from './modules/core-auth/infrastructure/jwt.strategy';

/**
 * Seeder de DEMOSTRACIÓN: carga un negocio completo y ejercita TODAS las
 * funcionalidades usando los servicios reales (dispara FEFO, consecutivos y el
 * posteo automático al ledger). Deja un usuario Dueño con datos en cada módulo.
 *
 *   npm run seed:demo
 *
 * Requiere MongoDB (replica set). Guardado por usuario: si el usuario demo ya
 * existe, no vuelve a sembrar la data transaccional (evita duplicar
 * consecutivos). Forzar con SEED_FORCE=1.
 */

const oid = (d: { _id: unknown }): string => String(d._id);
const today = (): string => new Date().toLocaleDateString('en-CA');
const plusDays = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
};

async function seedDemo(): Promise<void> {
  const logger = new Logger('SeedDemo');
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  const done: string[] = [];
  const failed: string[] = [];
  async function section(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      done.push(name);
      logger.log(`✓ ${name}`);
    } catch (err) {
      failed.push(`${name}: ${(err as Error).message}`);
      logger.warn(`✗ ${name} — ${(err as Error).message}`);
    }
  }

  try {
    const sedesSvc = app.get(SedesService);
    const usersSvc = app.get(UsersService);
    const rolesSvc = app.get(RolesService);
    const suppliersSvc = app.get(SuppliersService);
    const productsSvc = app.get(ProductsService);
    const stockSvc = app.get(StockService);
    const catalogSvc = app.get(CatalogService);
    const cajaSvc = app.get(CajaService);
    const salesSvc = app.get(SalesService);
    const financeSvc = app.get(FinanceService);
    const purchasingSvc = app.get(PurchasingService);
    const restaurantSvc = app.get(RestaurantService);
    const employeesSvc = app.get(EmployeesService);
    const positionsSvc = app.get(PositionsService);
    const payrollSvc = app.get(PayrollService);
    const taxSvc = app.get(TaxService);
    const paramsSvc = app.get(ParamsService);
    const ledgerSvc = app.get(LedgerService);
    const auditSvc = app.get(AuditService);

    // ── Núcleo: roles + parámetros/impuestos/plan de cuentas ──────────────────
    await rolesSvc.ensureSystemRoles();
    await taxSvc.list();
    await paramsSvc.list();
    await ledgerSvc.listAccounts();
    logger.log('Núcleo asegurado (roles, impuestos, parámetros, plan de cuentas).');

    // ── Sedes ─────────────────────────────────────────────────────────────────
    let centro = (await sedesSvc.list()).find((s) => s.code === 'centro');
    if (!centro) {
      centro = await sedesSvc.create({
        code: 'centro',
        name: 'Sede Centro',
        businessName: 'Sabor & Brasa S.A.S.',
        address: 'Cra 10 # 20-30',
        nit: '901555444',
        phone: '3001112233',
      });
    }
    let norte = (await sedesSvc.list()).find((s) => s.code === 'norte');
    if (!norte) {
      norte = await sedesSvc.create({
        code: 'norte',
        name: 'Sede Norte',
        address: 'Calle 100 # 15-20',
        phone: '3004445566',
      });
    }
    const centroId = oid(centro);
    const norteId = oid(norte);

    // ── Usuario Dueño demo ──────────────────────────────────────────────────────
    const demoEmail = process.env.SEED_DEMO_EMAIL ?? 'demo@sistemapos.local';
    const demoPassword = process.env.SEED_DEMO_PASSWORD ?? 'Demo123!';
    let demoUser = await usersSvc.findByEmail(demoEmail);
    const freshUser = !demoUser;
    if (!demoUser) {
      demoUser = await usersSvc.create({
        email: demoEmail,
        password: demoPassword,
        name: 'Camila Restrepo',
        role: ROLES.OWNER,
        sedeIds: [centroId, norteId],
      });
      logger.log(`Usuario Dueño demo creado: ${demoEmail} / ${demoPassword}`);
    }

    const owner: JwtUser = {
      userId: oid(demoUser),
      email: demoEmail,
      name: 'Camila Restrepo',
      role: ROLES.OWNER,
      permissions: [...ALL_PERMISSIONS],
      sedeIds: [centroId, norteId],
    };

    const force = process.env.SEED_FORCE === '1';
    if (!freshUser && !force) {
      logger.log(
        'El usuario demo ya existía: se omite la data transaccional (usa SEED_FORCE=1 para forzar).',
      );
      printCredentials(logger, demoEmail, demoPassword, centro.name, [], []);
      return;
    }

    // ── Proveedores ─────────────────────────────────────────────────────────────
    let supplierId: string | undefined;
    await section('Proveedores', async () => {
      const existing = await suppliersSvc.list(true);
      const seed = [
        { name: 'Distribuidora La Cosecha S.A.S.', docType: 'NIT' as const, docNumber: '901234567', city: 'Bogotá', category: 'Frutas y verduras' },
        { name: 'Carnes El Novillo', docType: 'NIT' as const, docNumber: '900876543', city: 'Bogotá', category: 'Cárnicos' },
        { name: 'Abarrotes Don José', docType: 'CC' as const, docNumber: '79456123', city: 'Bogotá', category: 'Abarrotes' },
      ];
      const byDoc = new Set(existing.map((s) => `${s.docType}:${s.docNumber}`));
      for (const s of seed) {
        if (!byDoc.has(`${s.docType}:${s.docNumber}`)) await suppliersSvc.create(s);
      }
      const all = await suppliersSvc.list(true);
      supplierId = all[0] ? oid(all[0]) : undefined;
    });

    // ── Inventario: insumos + stock (con lotes FEFO) ────────────────────────────
    const inv: Record<string, string> = {};
    await section('Inventario (insumos + stock)', async () => {
      const items = [
        { key: 'carne', sku: 'INS-CARNE', name: 'Carne de res', unit: 'kg', cost: 22000, perishable: true, trackLots: true, minStock: 3 },
        { key: 'pan', sku: 'INS-PAN', name: 'Pan de hamburguesa', unit: 'und', cost: 800, perishable: false, trackLots: false, minStock: 20 },
        { key: 'queso', sku: 'INS-QUESO', name: 'Queso tajado', unit: 'kg', cost: 18000, perishable: true, trackLots: true, minStock: 1 },
        { key: 'papa', sku: 'INS-PAPA', name: 'Papa a la francesa', unit: 'kg', cost: 4500, perishable: false, trackLots: false, minStock: 5 },
        { key: 'gaseosa', sku: 'INS-GAS', name: 'Gaseosa 400ml', unit: 'und', cost: 1800, perishable: false, trackLots: false, minStock: 12 },
      ];
      for (const it of items) {
        const p = await productsSvc.create({
          sku: it.sku, name: it.name, unit: it.unit, cost: it.cost,
          perishable: it.perishable, trackLots: it.trackLots, minStock: it.minStock,
        });
        inv[it.key] = oid(p);
      }
      // Entradas de stock en Centro (perecederos con vencimiento).
      const entries = [
        { key: 'carne', qty: 12, exp: plusDays(20) },
        { key: 'pan', qty: 150 },
        { key: 'queso', qty: 3, exp: plusDays(25) },
        { key: 'papa', qty: 20 },
        { key: 'gaseosa', qty: 80 },
      ];
      for (const e of entries) {
        await stockSvc.entry(
          { productId: inv[e.key]!, sedeId: centroId, qty: e.qty, expiresAt: e.exp },
          owner,
        );
      }
      // Algo de stock en Norte también.
      await stockSvc.entry({ productId: inv.gaseosa!, sedeId: norteId, qty: 40 }, owner);
    });

    // ── Catálogo (vendibles del POS) ────────────────────────────────────────────
    const menu: Record<string, string> = {};
    await section('Catálogo (menú vendible)', async () => {
      // Bebida: fuente inventario (consume 1 gaseosa por unidad vendida).
      const bebida = await catalogSvc.create({
        sku: 'MEN-GAS', name: 'Gaseosa 400ml', salePrice: 4000,
        ivaRate: 19, ivaType: 'gravado',
        sourceType: 'inventory', inventoryProductId: inv.gaseosa!, qtyPerUnit: 1,
      });
      menu.gaseosa = oid(bebida);
      // Hamburguesa: receta (carne + pan + queso).
      const hamburguesa = await catalogSvc.create({
        sku: 'MEN-HAM', name: 'Hamburguesa clásica', salePrice: 18000,
        ivaRate: 0, ivaType: 'exento',
        sourceType: 'recipe',
        recipe: [
          { productId: inv.carne!, qty: 0.15 },
          { productId: inv.pan!, qty: 1 },
          { productId: inv.queso!, qty: 0.03 },
        ],
      });
      menu.hamburguesa = oid(hamburguesa);
      // Papas: receta (papa).
      const papas = await catalogSvc.create({
        sku: 'MEN-PAP', name: 'Papas a la francesa', salePrice: 8000,
        ivaRate: 0, ivaType: 'exento',
        sourceType: 'recipe', recipe: [{ productId: inv.papa!, qty: 0.2 }],
      });
      menu.papas = oid(papas);
    });

    // ── Caja + Ventas (POS) → posteo al ledger ──────────────────────────────────
    await section('Caja + ventas (POS)', async () => {
      await cajaSvc.open({ sedeId: centroId, openingAmount: 200000 }, owner);

      // Venta 1: efectivo.
      await salesSvc.create(
        {
          sedeId: centroId,
          lines: [
            { productId: menu.hamburguesa!, qty: 2 },
            { productId: menu.gaseosa!, qty: 2 },
          ],
          payment: { method: 'cash', received: 60000 },
        },
        owner,
      );
      // Venta 2: tarjeta.
      await salesSvc.create(
        {
          sedeId: centroId,
          lines: [
            { productId: menu.hamburguesa!, qty: 1 },
            { productId: menu.papas!, qty: 1 },
            { productId: menu.gaseosa!, qty: 1 },
          ],
          payment: { method: 'card' },
        },
        owner,
      );
      // Venta 3: crédito (fiado) → genera CxC.
      await salesSvc.create(
        {
          sedeId: centroId,
          lines: [{ productId: menu.hamburguesa!, qty: 3 }],
          payment: { method: 'credit', dueDate: plusDays(15) },
          customer: { name: 'Andrés Gómez', idNumber: '1020304050', phone: '3011234567' },
        },
        owner,
      );

      // Movimiento de caja (ingreso vario) y cierre con arqueo.
      await cajaSvc.movement(
        { sedeId: centroId, type: 'in', amount: 15000, reason: 'Reembolso caja menor' },
        owner,
      );
      await cajaSvc.close(
        { sedeId: centroId, countedAmount: 261000, note: 'Cierre demo' },
        owner,
      );
    });

    // ── Finanzas ────────────────────────────────────────────────────────────────
    await section('Finanzas (gastos, CxP, CxC, bancos, presupuesto)', async () => {
      const cats = await financeSvc.listCategories();
      const expenseCat = cats.find((c) => c.kind === 'expense') ?? cats[0]!;

      // Gasto pagado.
      await financeSvc.createExpense(
        {
          sedeId: centroId, categoryId: oid(expenseCat), concept: 'Arriendo local',
          amount: 2500000, taxAmount: 0, date: today(), status: 'paid', paymentMethod: 'transfer',
        },
        owner,
      );
      // Gasto por pagar.
      await financeSvc.createExpense(
        {
          sedeId: centroId, categoryId: oid(expenseCat), concept: 'Servicios públicos',
          amount: 380000, taxAmount: 0, date: today(), status: 'payable',
        },
        owner,
      );
      // CxP a proveedor + abono.
      const payable = await financeSvc.createPayable(
        {
          sedeId: centroId, supplierId, supplierName: 'Carnes El Novillo',
          docNumber: 'FC-8890', issueDate: today(), dueDate: plusDays(30), amount: 1200000,
          note: 'Compra de cárnicos',
        },
        owner,
      );
      await financeSvc.addPayablePayment(
        oid(payable), { date: today(), amount: 500000, method: 'cash' }, owner,
      );
      // CxC (fiado) directa + abono.
      const receivable = await financeSvc.createReceivable(
        {
          sedeId: centroId, customerName: 'Restaurante Aliado', customerDoc: '901112223',
          docNumber: 'RC-001', issueDate: today(), dueDate: plusDays(20), amount: 300000,
        },
        owner,
      );
      await financeSvc.addReceivablePayment(
        oid(receivable), { date: today(), amount: 100000, method: 'transfer' }, owner,
      );
      // Cuenta de banco + movimientos.
      const account = await financeSvc.createAccount(
        { sedeId: centroId, type: 'bank', name: 'Bancolombia principal', openingBalance: 5000000 }, owner,
      );
      await financeSvc.createMovement(
        oid(account), { date: today(), direction: 'in', amount: 1500000, concept: 'Consignación ventas' }, owner,
      );
      await financeSvc.createMovement(
        oid(account), { date: today(), direction: 'out', amount: 380000, concept: 'Pago servicios' }, owner,
      );
      // Presupuesto anual.
      const budgetCats = cats.filter((c) => c.kind === 'expense' || c.kind === 'income').slice(0, 3);
      await financeSvc.createBudget(
        {
          name: 'Presupuesto 2026', fiscalYear: 2026, sedeId: centroId,
          lines: budgetCats.map((c) => ({
            categoryId: oid(c), categoryName: c.name, kind: c.kind,
            monthly: Array(12).fill(c.kind === 'income' ? 30000000 : 5000000),
          })),
        },
        owner,
      );
    });

    // ── Compras (OC + recepción → inventario + CxP + ledger) ────────────────────
    await section('Compras (OC + recepción)', async () => {
      const po = await purchasingSvc.create(
        {
          sedeId: centroId, supplierId, supplierName: 'Distribuidora La Cosecha S.A.S.',
          issueDate: today(), expectedDate: plusDays(3),
          lines: [
            { productId: inv.papa, description: 'Papa a la francesa', qty: 30, unitCost: 4500 },
            { productId: inv.gaseosa, description: 'Gaseosa 400ml', qty: 60, unitCost: 1800 },
          ],
          note: 'Pedido semanal', send: true,
        },
        owner,
      );
      // Recepción parcial con generación de CxP.
      await purchasingSvc.receive(
        oid(po),
        {
          date: today(),
          lines: [
            { lineIndex: 0, qty: 30 },
            { lineIndex: 1, qty: 40 },
          ],
          generatePayable: true, dueDate: plusDays(30),
        },
        owner,
      );
    });

    // ── Restaurante (mesas + comanda completa) ──────────────────────────────────
    await section('Restaurante (mesas + comanda)', async () => {
      const zones: { name: string; zone: string }[] = [
        { name: 'Mesa 1', zone: 'Principal' }, { name: 'Mesa 2', zone: 'Principal' },
        { name: 'Mesa 3', zone: 'Principal' }, { name: 'Mesa 4', zone: 'Terraza' },
        { name: 'Mesa 5', zone: 'Terraza' },
      ];
      const tables = [];
      for (const t of zones) {
        tables.push(await restaurantSvc.createTable({ sedeId: centroId, ...t, seats: 4 }, owner));
      }
      // Comanda en Mesa 1: pedir, enviar a cocina, propina, cerrar.
      const order = await restaurantSvc.openOrder({ tableId: oid(tables[0]!), guests: 3 }, owner);
      await restaurantSvc.addItems(
        oid(order),
        {
          items: [
            { name: 'Hamburguesa clásica', qty: 3, unitPrice: 18000, station: 'parrilla' },
            { name: 'Gaseosa 400ml', qty: 3, unitPrice: 4000, station: 'barra' },
          ],
        },
        owner,
      );
      await restaurantSvc.sendToKitchen(oid(order), owner);
      await restaurantSvc.setTip(oid(order), { accepted: true }, owner);
      await restaurantSvc.closeOrder(oid(order), owner);
      // Segunda mesa abierta (queda ocupada, para ver estados).
      const order2 = await restaurantSvc.openOrder({ tableId: oid(tables[1]!), guests: 2 }, owner);
      await restaurantSvc.addItems(
        oid(order2),
        { items: [{ name: 'Papas a la francesa', qty: 2, unitPrice: 8000 }] },
        owner,
      );
    });

    // ── Personal + Nómina ───────────────────────────────────────────────────────
    await section('Empleados + nómina', async () => {
      const cargos: Record<string, string> = {};
      for (const name of ['Cajero', 'Cocinero', 'Mesero']) {
        try {
          const pos = await positionsSvc.create({ name });
          cargos[name] = oid(pos);
        } catch {
          /* ya existe */
        }
      }
      const empleados = [
        { docNumber: '1015447788', firstName: 'Laura', lastName: 'Martínez', position: 'Cajero', salary: 1623500 },
        { docNumber: '1032556677', firstName: 'Diego', lastName: 'Ramírez', position: 'Cocinero', salary: 1800000 },
        { docNumber: '1045667788', firstName: 'Sofía', lastName: 'Hernández', position: 'Mesero', salary: 1623500 },
      ];
      for (const e of empleados) {
        await employeesSvc.create({
          docType: 'CC', docNumber: e.docNumber, firstName: e.firstName, lastName: e.lastName,
          positionId: cargos[e.position], sedeId: centroId, contractType: 'indefinido',
          hireDate: '2026-01-15', salary: e.salary, salaryType: 'ordinario', status: 'activo',
        });
      }
      // Corrida de nómina del período.
      await payrollSvc.createRun({ period: '2026-07', coverage: 'all' }, owner);
    });

    // ── Auditoría (las llamadas directas no pasan por el interceptor HTTP) ───────
    await section('Auditoría (eventos de muestra)', async () => {
      const events = [
        { method: 'POST', path: '/auth/login' },
        { method: 'POST', path: '/sales' },
        { method: 'POST', path: '/caja/close' },
        { method: 'POST', path: '/purchasing/orders' },
        { method: 'PATCH', path: '/finance/payables' },
      ];
      for (const ev of events) {
        await auditSvc.record({
          userId: owner.userId, userEmail: owner.email, userName: owner.name,
          role: owner.role, method: ev.method, path: ev.path, statusCode: 201,
          success: true, ip: '127.0.0.1',
        });
      }
    });

    printCredentials(logger, demoEmail, demoPassword, centro.name, done, failed);
  } finally {
    await app.close();
  }
}

function printCredentials(
  logger: Logger,
  email: string,
  password: string,
  sede: string,
  done: string[],
  failed: string[],
): void {
  logger.log('════════════════════════════════════════════════');
  logger.log(' SEED DE DEMOSTRACIÓN COMPLETADO');
  logger.log('════════════════════════════════════════════════');
  logger.log(` Usuario:    ${email}`);
  logger.log(` Contraseña: ${password}`);
  logger.log(` Rol:        Dueño (acceso total)`);
  logger.log(` Sede base:  ${sede}`);
  if (done.length) logger.log(` Módulos sembrados: ${done.length}`);
  if (failed.length) {
    logger.warn(` Secciones con problemas (${failed.length}):`);
    for (const f of failed) logger.warn(`   - ${f}`);
  }
  logger.log('════════════════════════════════════════════════');
}

seedDemo().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fallo el seed de demo:', err);
  process.exit(1);
});
