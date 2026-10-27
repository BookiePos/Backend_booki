import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Entorno, levantarEntorno } from './mongo-real';
import { SalesService } from '../modules/sales/application/sales.service';
import { OfflineSalesService } from '../modules/sales/application/offline-sales.service';
import { CajaService } from '../modules/caja/application/caja.service';
import { Sale, SaleSchema } from '../modules/sales/infrastructure/schemas/sale.schema';
import { Counter, CounterSchema } from '../modules/sales/infrastructure/schemas/counter.schema';
import {
  OfflineReservation,
  OfflineReservationSchema,
} from '../modules/sales/infrastructure/schemas/offline-reservation.schema';
import {
  OfflineSaleClaim,
  OfflineSaleClaimSchema,
} from '../modules/sales/infrastructure/schemas/offline-sale-claim.schema';
import {
  OfflineConflictRecord,
  OfflineConflictSchema,
} from '../modules/sales/infrastructure/schemas/offline-conflict.schema';
import {
  StockItem,
  StockItemSchema,
} from '../modules/inventory/infrastructure/schemas/stock-item.schema';
import {
  CajaSession,
  CajaSessionSchema,
} from '../modules/caja/infrastructure/schemas/caja-session.schema';
import {
  CajaMovement,
  CajaMovementSchema,
} from '../modules/caja/infrastructure/schemas/caja-movement.schema';
import type { JwtUser } from '../modules/core-auth/infrastructure/jwt.strategy';
import type { SyncOfflineSaleDto } from '../modules/sales/application/dto/offline-sale.dto';

/**
 * Modo sin conexión (ítem 6.3) contra un Mongo real: reserva de consecutivos
 * concurrente, sincronización idempotente por UUID y que la venta offline
 * cuadre caja y libro igual que una en línea.
 *
 * La venta pasa por el `SalesService.create` REAL con sus modelos reales
 * (ventas, contador, stock, turnos) y el libro REAL; solo se simulan los
 * servicios de catálogo y lotes, que no son lo que se prueba aquí.
 */
describe('ventas offline · reserva y sincronización', () => {
  const EMPRESA = 'eeeeeeeeeeeeeeeeeeeeeeee';
  const OTRA = 'ffffffffffffffffffffffff';
  const SEDE = new Types.ObjectId('68b0f3c2a1d4e5f6a7b8c9d1');
  const PROD = new Types.ObjectId();
  const INV = new Types.ObjectId();

  const cajero: JwtUser = {
    userId: 'u-cajero',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [SEDE.toString()],
    permissions: ['pos.sell'],
  } as unknown as JwtUser;
  const otroCajero = { ...cajero, userId: 'u-otro', email: 'otro@bookipos.local' } as JwtUser;
  /** Quien autoriza anulaciones: puede registrar un conflicto con lo cobrado. */
  const jefe = {
    ...cajero,
    permissions: ['pos.sell', 'pos.void.authorize'],
  } as unknown as JwtUser;

  let env: Entorno;
  let offline: OfflineSalesService;
  let caja: CajaService;
  let sell: ReturnType<typeof vi.fn>;
  let sales: SalesService;
  let sesiones: Model<unknown>;
  let stock: Model<unknown>;

  /** Una arepa a $11.900 con IVA del 19 % incluido. */
  const arepa = {
    _id: PROD,
    sku: 'A1',
    name: 'Arepa',
    unit: 'und',
    salePrice: 11_900,
    ivaType: 'gravado',
    ivaRate: 19,
    sourceType: 'inventory',
    inventoryProductId: INV,
    qtyPerUnit: 1,
    active: true,
  };
  let catalogoActivo = true;

  beforeAll(async () => {
    env = await levantarEntorno();
    const m = <T>(name: string, schema: unknown) => env.modelo<Model<T>>(name, schema);
    const saleModel = m<unknown>(Sale.name, SaleSchema);
    const counterModel = m<unknown>(Counter.name, CounterSchema);
    stock = m<unknown>(StockItem.name, StockItemSchema);
    sesiones = m<unknown>(CajaSession.name, CajaSessionSchema);
    const movimientos = m<unknown>(CajaMovement.name, CajaMovementSchema);

    // Lotes simulados: descuenta del stock REAL y devuelve el costo del lote.
    sell = vi.fn(async (_sede: string, lines: { productId: string; qty: number }[]) => {
      for (const l of lines) {
        await stock.updateOne(
          { sedeId: SEDE, productId: new Types.ObjectId(l.productId) },
          { $inc: { qty: -l.qty } },
        );
      }
      return lines.map((l) => ({
        product: { _id: INV, sku: 'INV-A', name: 'Masa', unit: 'und' },
        portions: [{ lot: { _id: new Types.ObjectId(), unitCost: 4_000 }, qty: l.qty }],
      }));
    });

    sales = new SalesService(
      saleModel as never,
      counterModel as never,
      stock as never,
      sesiones as never,
      {} as never, // discountModel: offline no lleva descuentos
      {} as never, // receivableModel: offline no fía
      { sell, reverseSale: vi.fn() } as never,
      // Último costo de compra de la masa: costea el faltante autorizado.
      { getOrFail: vi.fn().mockResolvedValue({ name: 'Masa', cost: 4_000 }) } as never,
      { findOrFail: vi.fn().mockResolvedValue({ _id: SEDE }) } as never,
      {
        loadSellableOrFail: vi.fn(async (_id: string, o?: { allowInactive?: boolean }) => {
          if (!catalogoActivo && !o?.allowInactive) {
            const { BadRequestException } = await import('@nestjs/common');
            throw new BadRequestException('El producto Arepa está inactivo');
          }
          return arepa;
        }),
        packagingOf: vi.fn(() => []),
        componentsOf: vi.fn((p: typeof arepa, qty: number) => [
          { productId: p.inventoryProductId.toString(), qty },
        ]),
      } as never,
      { rulesFor: vi.fn().mockResolvedValue(null) } as never,
      {} as never, // deliveryZones: offline no hace domicilios
      {} as never, // customers
      {} as never, // payroll
      {} as never, // params
      env.posting,
      { post: vi.fn() } as never, // tesorería: el efectivo no pasa por bancos
      {} as never,
      {} as never,
      { findById: vi.fn().mockResolvedValue({ tipoNegocio: 'retail' }) } as never,
      {} as never,
      {} as never,
    );
    offline = new OfflineSalesService(
      counterModel as never,
      m(OfflineReservation.name, OfflineReservationSchema) as never,
      m(OfflineSaleClaim.name, OfflineSaleClaimSchema) as never,
      saleModel as never,
      sesiones as never,
      sales,
      m(OfflineConflictRecord.name, OfflineConflictSchema) as never,
      // Regularizar un faltante saca del stock real con su costo de lote.
      {
        consumeLines: vi.fn(
          async (_t: string, _sede: string, lines: { productId: string; qty: number }[]) => {
            for (const l of lines) {
              const it = (await stock
                .findOne({ sedeId: SEDE, productId: new Types.ObjectId(l.productId) })
                .lean()) as { qty: number } | null;
              if (!it || it.qty < l.qty) {
                const { BadRequestException } = await import('@nestjs/common');
                throw new BadRequestException('Stock insuficiente');
              }
              await stock.updateOne(
                { sedeId: SEDE, productId: new Types.ObjectId(l.productId) },
                { $inc: { qty: -l.qty } },
              );
            }
            return lines.map((l) => ({
              product: { _id: INV },
              portions: [{ lot: { _id: new Types.ObjectId(), unitCost: 4_500 }, qty: l.qty }],
            }));
          },
        ),
      } as never,
      env.posting,
    );
    caja = new CajaService(
      sesiones as never,
      movimientos as never,
      saleModel as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  const base = () => env.baseDe(EMPRESA);
  let turnoId: Types.ObjectId;

  beforeEach(async () => {
    catalogoActivo = true;
    sell.mockClear();
    await env.enEmpresa(EMPRESA, async () => {
      for (const c of [
        'sales',
        'offline_sale_claims',
        'offline_conflicts',
        'caja_sessions',
        'stock_items',
        'ledger_journal_entries',
      ]) {
        await base().collection(c).deleteMany({});
      }
      const s = (await sesiones.create({
        sedeId: SEDE,
        status: 'open',
        openingAmount: 100_000,
        openedById: cajero.userId,
        openedByEmail: cajero.email,
        openedAt: new Date(),
      })) as unknown as { _id: Types.ObjectId };
      turnoId = s._id;
      await stock.create({ sedeId: SEDE, productId: INV, qty: 10 });
    });
  });

  const reservar = (user = cajero, count = 5) =>
    env.enEmpresa(EMPRESA, () =>
      offline.reserve({ sedeId: SEDE.toString(), deviceId: 'caja-1', count }, user),
    );

  /** Dos arepas en efectivo con $2.000 de propina: $25.800 al cliente. */
  const venta = (
    r: { reservationId: string; from: number },
    extra: Partial<SyncOfflineSaleDto> = {},
  ): SyncOfflineSaleDto =>
    ({
      offlineId: randomUUID(),
      reservationId: r.reservationId,
      saleNumber: `FVC-${String(r.from).padStart(6, '0')}`,
      soldAt: new Date().toISOString(),
      expectedGrandTotal: 25_800,
      sale: {
        sedeId: SEDE.toString(),
        lines: [{ productId: PROD.toString(), qty: 2 }],
        payment: { method: 'cash', received: 30_000 },
        tip: 2_000,
        orderType: 'mostrador',
      },
      ...extra,
    }) as SyncOfflineSaleDto;

  const conflicto = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as { getResponse(): { reason: string } }).getResponse().reason;
    }
    throw new Error('se esperaba un conflicto');
  };

  it('20 reservas en paralelo reciben rangos disjuntos y contiguos', async () => {
    const reservas = await Promise.all(Array.from({ length: 20 }, () => reservar(cajero, 7)));
    const numeros = reservas.flatMap((r) =>
      Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i),
    );
    expect(numeros).toHaveLength(140);
    expect(new Set(numeros).size).toBe(140);
    const orden = [...numeros].sort((a, b) => a - b);
    expect(orden[orden.length - 1]! - orden[0]! + 1).toBe(140);
    expect(reservas.every((r) => r.cajaSessionId === turnoId.toString())).toBe(true);
  });

  it('la misma venta enviada 6 veces (5 a la vez y un reenvío) queda registrada una sola vez', async () => {
    const r = await reservar();
    const dto = venta(r);
    const resultados = await Promise.allSettled(
      Array.from({ length: 5 }, () => env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero))),
    );
    const ok = resultados.filter((x) => x.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Las que no ganaron el candado salen como EN_PROCESO (reintentables).
    for (const x of resultados) {
      if (x.status === 'rejected') {
        expect((x.reason as { getResponse(): { reason: string } }).getResponse().reason).toBe('EN_PROCESO');
      }
    }
    const reenvio = await env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero));
    expect(reenvio.status).toBe('duplicada');

    expect(await base().collection('sales').countDocuments({ offlineId: dto.offlineId })).toBe(1);
    expect(sell).toHaveBeenCalledTimes(1);
    const stockDoc = await base().collection('stock_items').findOne({ productId: INV });
    expect(stockDoc?.qty).toBe(8);
    expect(
      await base().collection('ledger_journal_entries').countDocuments({ sourceType: 'sale' }),
    ).toBe(1);
  });

  it('la venta offline lleva el número y la fecha originales y cuadra caja y libro', async () => {
    const r = await reservar();
    const ayer = new Date(Date.now() - 60_000);
    const dto = venta(r, { soldAt: ayer.toISOString() });
    const { sale } = await env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero));
    expect(sale.saleNumber).toBe(dto.saleNumber);
    expect(sale.cajaSessionId?.toString()).toBe(turnoId.toString());
    expect(sale.total).toBe(23_800);
    expect(sale.payment).toMatchObject({ method: 'cash', received: 30_000, change: 4_200 });

    // Caja: base $100.000 + lo que entró al cajón ($23.800 + $2.000 propina).
    const cur = await env.enEmpresa(EMPRESA, () => caja.current(SEDE.toString(), cajero));
    expect(cur.totals?.expectedCash).toBe(125_800);
    expect(cur.totals?.salesCount).toBe(1);

    // Libro: un asiento cuadrado, con la fecha del cobro.
    const asiento = await base().collection('ledger_journal_entries').findOne({ sourceType: 'sale' });
    expect(asiento?.totalDebit).toBe(asiento?.totalCredit);
    expect(asiento?.date).toBe(ayer.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }));
    const caja1105 = (asiento?.lines as { accountCode: string; debit: number }[]).find((l) =>
      l.accountCode.startsWith('1105'),
    );
    expect(caja1105?.debit).toBe(25_800);
  });

  it('turno cerrado: conflicto sin tocar inventario; luego entra al turno abierto si se pide', async () => {
    const r = await reservar();
    await env.enEmpresa(EMPRESA, () =>
      sesiones.updateOne({ _id: turnoId }, { $set: { status: 'closed', closedAt: new Date() } }),
    );
    const dto = venta(r);
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)))).toBe('TURNO_CERRADO');
    expect(sell).not.toHaveBeenCalled();
    expect(await base().collection('offline_sale_claims').countDocuments()).toBe(0);

    const nuevo = (await env.enEmpresa(EMPRESA, () =>
      sesiones.create({
        sedeId: SEDE,
        status: 'open',
        openingAmount: 50_000,
        openedById: cajero.userId,
        openedByEmail: cajero.email,
        openedAt: new Date(),
      }),
    )) as unknown as { _id: Types.ObjectId };
    const { sale } = await env.enEmpresa(EMPRESA, () =>
      offline.sync({ ...dto, useOpenShift: true }, cajero),
    );
    expect(sale.cajaSessionId?.toString()).toBe(nuevo._id.toString());
  });

  it('precio cambiado: TOTAL_DISTINTO y el inventario queda igual', async () => {
    const r = await reservar();
    const dto = venta(r, { expectedGrandTotal: 23_000 });
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)))).toBe('TOTAL_DISTINTO');
    expect(sell).not.toHaveBeenCalled();
    // Reintentable con el mismo UUID una vez se corrige.
    const ok = await env.enEmpresa(EMPRESA, () =>
      offline.sync({ ...dto, expectedGrandTotal: 25_800 }, cajero),
    );
    expect(ok.status).toBe('creada');
  });

  it('producto inactivo y sin stock van a la bandeja con su motivo', async () => {
    const r = await reservar();
    catalogoActivo = false;
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(venta(r), cajero)))).toBe(
      'PRODUCTO_INACTIVO',
    );
    catalogoActivo = true;
    await env.enEmpresa(EMPRESA, () => stock.updateOne({ productId: INV }, { $set: { qty: 1 } }));
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(venta(r), cajero)))).toBe('SIN_STOCK');
  });

  it('un consecutivo no se usa dos veces, ni fuera de su reserva, ni por otro usuario', async () => {
    const r = await reservar();
    await env.enEmpresa(EMPRESA, () => offline.sync(venta(r), cajero));
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(venta(r), cajero)))).toBe('NUMERO_USADO');
    expect(
      await conflicto(
        env.enEmpresa(EMPRESA, () => offline.sync(venta({ ...r, from: r.to + 1 }), cajero)),
      ),
    ).toBe('NUMERO_INVALIDO');
    expect(
      await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(venta({ ...r, from: r.from + 1 }), otroCajero))),
    ).toBe('NUMERO_INVALIDO');
  });

  it('solo efectivo: tarjeta o fiado offline se rechazan', async () => {
    const r = await reservar();
    const dto = venta(r);
    dto.sale.payment = { method: 'card' } as never;
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)))).toBe('NO_PERMITIDA_OFFLINE');
  });

  it('la reserva de una empresa no sirve en otra', async () => {
    const r = await reservar();
    const reason = await conflicto(env.enEmpresa(OTRA, () => offline.sync(venta(r), cajero)));
    expect(reason).toBe('NUMERO_INVALIDO');
    expect(await env.baseDe(OTRA).collection('sales').countDocuments()).toBe(0);
  });

  it('turno cerrado + turno abierto: la venta entra al abierto y ese turno queda anotado', async () => {
    const r = await reservar();
    await env.enEmpresa(EMPRESA, () =>
      sesiones.updateOne(
        { _id: turnoId },
        { $set: { status: 'closed', closedAt: new Date(Date.now() + 60_000) } },
      ),
    );
    const nuevo = (await env.enEmpresa(EMPRESA, () =>
      sesiones.create({
        sedeId: SEDE,
        status: 'open',
        openingAmount: 0,
        openedById: cajero.userId,
        openedByEmail: cajero.email,
        openedAt: new Date(),
      }),
    )) as unknown as { _id: Types.ObjectId };
    const dto = venta(r, { useOpenShift: true });
    await env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero));
    const turno = await base().collection('caja_sessions').findOne({ _id: nuevo._id });
    expect(turno?.offlineNotes).toEqual([expect.stringContaining(dto.saleNumber)]);
    const v = await base().collection('sales').findOne({ offlineId: dto.offlineId });
    expect(v?.offlineTurnoOrigenId?.toString()).toBe(turnoId.toString());
  });

  it('TOTAL_DISTINTO queda en la bandeja del servidor y quien autoriza la registra con el precio cobrado', async () => {
    const r = await reservar();
    // El comprobante cobró la arepa a $10.500: 2 × 10.500 + 2.000 de propina.
    const dto = venta(r, {
      expectedGrandTotal: 23_000,
      chargedLines: [{ productId: PROD.toString(), unitPrice: 10_500 }],
    });
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)))).toBe('TOTAL_DISTINTO');
    const bandeja = await env.enEmpresa(EMPRESA, () =>
      offline.listConflicts(SEDE.toString(), jefe),
    );
    expect(bandeja.map((c) => c._id)).toEqual([dto.offlineId]);
    expect(bandeja[0]?.reason).toBe('TOTAL_DISTINTO');

    // El cajero no puede forzarla; quien autoriza anulaciones sí.
    await expect(
      env.enEmpresa(EMPRESA, () => offline.sync({ ...dto, override: true }, cajero)),
    ).rejects.toMatchObject({ status: 403 });
    const { sale } = await env.enEmpresa(EMPRESA, () =>
      offline.sync({ ...dto, override: true }, jefe),
    );
    expect(sale.total).toBe(21_000);
    expect(sale.lines[0]?.unitPrice).toBe(10_500);
    expect(sale.offlineOverride?.byUserId).toBe(jefe.userId);
    const asiento = await base().collection('ledger_journal_entries').findOne({ sourceType: 'sale' });
    expect(asiento?.totalDebit).toBe(asiento?.totalCredit);
    expect(
      await env.enEmpresa(EMPRESA, () => offline.listConflicts(SEDE.toString(), jefe)),
    ).toHaveLength(0);
  });

  it('SIN_STOCK con autorización: registra, descuenta lo que había y deja el faltante', async () => {
    const r = await reservar();
    await env.enEmpresa(EMPRESA, () => stock.updateOne({ productId: INV }, { $set: { qty: 1 } }));
    const dto = venta(r, { chargedLines: [{ productId: PROD.toString(), unitPrice: 11_900 }] });
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)))).toBe('SIN_STOCK');
    const { sale } = await env.enEmpresa(EMPRESA, () =>
      offline.sync({ ...dto, override: true }, jefe),
    );
    expect(sale.total).toBe(23_800);
    // El faltante se costea al último costo y queda pendiente de regularizar.
    expect(sale.offlineOverride?.faltantes).toEqual([
      expect.objectContaining({
        productId: INV,
        qty: 1,
        unitCost: 4_000,
        cost: 4_000,
        status: 'pendiente',
      }),
    ]);
    const stockDoc = await base().collection('stock_items').findOne({ productId: INV });
    expect(stockDoc?.qty).toBe(0);

    // Costo de ventas: lo consumido (1 x 4.000) + el faltante (4.000) contra la
    // cuenta puente 143595.
    const asiento = await base().collection('ledger_journal_entries').findOne({ sourceType: 'sale' });
    const lineas = asiento?.lines as { accountCode: string; debit: number; credit: number }[];
    expect(asiento?.totalDebit).toBe(asiento?.totalCredit);
    expect(lineas.filter((l) => l.accountCode === '6135').reduce((x, l) => x + l.debit, 0)).toBe(8_000);
    expect(lineas.find((l) => l.accountCode === '143595')?.credit).toBe(4_000);
    expect(lineas.find((l) => l.accountCode === '1435')?.credit).toBe(4_000);

    // Bandeja de faltantes de la sede, para quien autoriza.
    const pendientes = await env.enEmpresa(EMPRESA, () =>
      offline.listFaltantes(SEDE.toString(), jefe),
    );
    expect(pendientes.map((p) => p.saleNumber)).toEqual([dto.saleNumber]);

    // Sin stock registrado todavía no se puede regularizar.
    await expect(
      env.enEmpresa(EMPRESA, () => offline.regularizarFaltantes(sale._id.toString(), jefe)),
    ).rejects.toMatchObject({ status: 400 });
    // Llega la compra que faltaba: se saca del stock real y se cierra la puente.
    await env.enEmpresa(EMPRESA, () => stock.updateOne({ productId: INV }, { $set: { qty: 3 } }));
    await env.enEmpresa(EMPRESA, () => offline.regularizarFaltantes(sale._id.toString(), jefe));
    expect((await base().collection('stock_items').findOne({ productId: INV }))?.qty).toBe(2);
    const reg = await base()
      .collection('ledger_journal_entries')
      .findOne({ sourceType: 'offline_faltante' });
    const rl = reg?.lines as { accountCode: string; debit: number; credit: number }[];
    expect(reg?.totalDebit).toBe(reg?.totalCredit);
    expect(rl.find((l) => l.accountCode === '143595')?.debit).toBe(4_000);
    expect(rl.find((l) => l.accountCode === '1435')?.credit).toBe(4_500);
    expect(rl.find((l) => l.accountCode === '6135')?.debit).toBe(500);
    expect(
      await env.enEmpresa(EMPRESA, () => offline.listFaltantes(SEDE.toString(), jefe)),
    ).toHaveLength(0);
    // Dos veces no: ya no hay faltante pendiente.
    await expect(
      env.enEmpresa(EMPRESA, () => offline.regularizarFaltantes(sale._id.toString(), jefe)),
    ).rejects.toMatchObject({ status: 400 });
    expect((await base().collection('stock_items').findOne({ productId: INV }))?.qty).toBe(2);
  });

  it('regularizar: un candado viejo se retoma y un `consumiendo` huérfano no saca stock dos veces', async () => {
    const r = await reservar();
    await env.enEmpresa(EMPRESA, () => stock.updateOne({ productId: INV }, { $set: { qty: 1 } }));
    const dto = venta(r, { chargedLines: [{ productId: PROD.toString(), unitPrice: 11_900 }] });
    await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)));
    const { sale } = await env.enEmpresa(EMPRESA, () =>
      offline.sync({ ...dto, override: true }, jefe),
    );
    await env.enEmpresa(EMPRESA, () => stock.updateOne({ productId: INV }, { $set: { qty: 5 } }));

    // Una petición que murió hace 3 min dejó el candado: se retoma.
    await base()
      .collection('sales')
      .updateOne(
        { _id: sale._id },
        { $set: { 'offlineOverride.regularizandoAt': new Date(Date.now() - 180_000) } },
      );
    await env.enEmpresa(EMPRESA, () => offline.regularizarFaltantes(sale._id.toString(), jefe));
    const tras = await base().collection('sales').findOne({ _id: sale._id });
    expect(tras?.offlineOverride?.faltantes?.[0]?.status).toBe('regularizado');
    expect(tras?.offlineOverride?.regularizandoAt).toBeUndefined();
    expect((await base().collection('stock_items').findOne({ productId: INV }))?.qty).toBe(4);

    // Simula una corrida que murió al sacar stock: queda `consumiendo`.
    await base()
      .collection('sales')
      .updateOne(
        { _id: sale._id },
        { $set: { 'offlineOverride.faltantes.0.status': 'consumiendo' } },
      );
    await expect(
      env.enEmpresa(EMPRESA, () => offline.regularizarFaltantes(sale._id.toString(), jefe)),
    ).rejects.toMatchObject({ status: 409 });
    expect((await base().collection('stock_items').findOne({ productId: INV }))?.qty).toBe(4);
  });

  it('override sin conflicto abierto en el servidor no registra nada', async () => {
    const r = await reservar();
    const dto = venta(r, { chargedLines: [{ productId: PROD.toString(), unitPrice: 1 }] });
    await expect(
      env.enEmpresa(EMPRESA, () => offline.sync({ ...dto, override: true }, jefe)),
    ).rejects.toMatchObject({ status: 403 });
    expect(sell).not.toHaveBeenCalled();
    expect(await base().collection('sales').countDocuments()).toBe(0);
  });

  it('PRODUCTO_INACTIVO con autorización: registra con el precio cobrado', async () => {
    const r = await reservar();
    catalogoActivo = false;
    const dto = venta(r, {
      chargedLines: [{ productId: PROD.toString(), unitPrice: 11_900 }],
    });
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)))).toBe(
      'PRODUCTO_INACTIVO',
    );
    const { sale } = await env.enEmpresa(EMPRESA, () =>
      offline.sync({ ...dto, override: true }, jefe),
    );
    expect(sale.total).toBe(23_800);
  });

  it('cobro en línea con llave: el reintento no duplica y la misma llave offline se reconoce', async () => {
    const key = randomUUID();
    const dto = {
      sedeId: SEDE.toString(),
      lines: [{ productId: PROD.toString(), qty: 1 }],
      payment: { method: 'cash', received: 20_000 },
      orderType: 'mostrador',
      idempotencyKey: key,
    } as never;
    // Doble clic: el candado de la llave deja numerar y vender a uno solo.
    const contador = await base().collection('counters').findOne({ _id: `sale:${SEDE.toString()}` as never });
    const antes = (contador?.seq as number | undefined) ?? 0;
    const intentos = await Promise.allSettled([
      env.enEmpresa(EMPRESA, () => sales.create(dto, cajero)),
      env.enEmpresa(EMPRESA, () => sales.create(dto, cajero)),
    ]);
    const hechas = intentos.filter((x) => x.status === 'fulfilled');
    expect(hechas.length).toBeGreaterThanOrEqual(1);
    for (const x of intentos) {
      if (x.status === 'rejected') expect((x.reason as { status: number }).status).toBe(409);
    }
    const a = (hechas[0] as PromiseFulfilledResult<Awaited<ReturnType<SalesService['create']>>>)
      .value;
    expect(await base().collection('sales').countDocuments()).toBe(1);
    expect(sell).toHaveBeenCalledTimes(1);
    // Sin hueco en la serie FV-: se gastó un solo número.
    const despues = await base().collection('counters').findOne({ _id: `sale:${SEDE.toString()}` as never });
    expect((despues?.seq as number) - antes).toBe(1);
    // Reintento tras perder la respuesta: devuelve la misma, sin vender otra vez.
    sell.mockClear();
    const c = await env.enEmpresa(EMPRESA, () => sales.create(dto, cajero));
    expect(c._id.toString()).toBe(a._id.toString());
    expect(sell).not.toHaveBeenCalled();

    // El cajero creyó que se cayó y la cobró sin red con la misma llave.
    const r = await reservar();
    const offlineDto = venta(r, { offlineId: key, expectedGrandTotal: 11_900 });
    offlineDto.sale.lines = [{ productId: PROD.toString(), qty: 1 }];
    offlineDto.sale.tip = undefined;
    const res = await env.enEmpresa(EMPRESA, () => offline.sync(offlineDto, cajero));
    expect(res.status).toBe('duplicada');
    expect(res.sale.saleNumber).toBe(a.saleNumber);
    expect(await base().collection('sales').countDocuments()).toBe(1);
  });

  it('quien autoriza resuelve desde la bandeja del servidor un conflicto de otro cajero', async () => {
    const r = await reservar();
    const dto = venta(r, {
      expectedGrandTotal: 23_000,
      chargedLines: [{ productId: PROD.toString(), unitPrice: 10_500 }],
    });
    expect(await conflicto(env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero)))).toBe('TOTAL_DISTINTO');
    const supervisora = {
      ...jefe,
      userId: 'u-supervisora',
      email: 'super@bookipos.local',
    } as JwtUser;
    const [c] = await env.enEmpresa(EMPRESA, () =>
      offline.listConflicts(SEDE.toString(), supervisora),
    );
    // Sin `override` el número sigue siendo solo de quien lo reservó.
    expect(
      await conflicto(
        env.enEmpresa(EMPRESA, () =>
          offline.sync(c!.payload as unknown as SyncOfflineSaleDto, supervisora),
        ),
      ),
    ).toBe('NUMERO_INVALIDO');
    const { sale } = await env.enEmpresa(EMPRESA, () =>
      offline.sync({ ...(c!.payload as unknown as SyncOfflineSaleDto), override: true }, supervisora),
    );
    expect(sale.saleNumber).toBe(dto.saleNumber);
    expect(sale.total).toBe(21_000);
    // La venta es de quien la cobró; la supervisora solo autorizó.
    expect(sale.cashierId).toBe(cajero.userId);
    expect(sale.cashierEmail).toBe(cajero.email);
    expect(sale.offlineOverride?.byUserId).toBe(supervisora.userId);
    // El terminal del cajero, al reintentar, la recibe como ya registrada.
    const again = await env.enEmpresa(EMPRESA, () => offline.sync(dto, cajero));
    expect(again.status).toBe('duplicada');
  });
});
