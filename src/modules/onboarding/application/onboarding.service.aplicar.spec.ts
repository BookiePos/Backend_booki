import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';

// Ver orders.service.checkout.spec.ts: neutraliza los decoradores de esquema.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { OnboardingService } from './onboarding.service';
import { OnboardingController } from '../infrastructure/onboarding.controller';
import { PERMISSIONS_KEY } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { SYSTEM_ROLES } from '../../core-auth/domain/roles';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { itemsDe, plantillaDe } from '../domain/plantillas';

/**
 * Servicio instanciado DIRECTAMENTE con fakes en memoria. Constructor (orden):
 *   catalogModel, productModel, categoryModel, catalog, products, stock, restaurant, sedes
 */
describe('OnboardingService.aplicar', () => {
  const sedeId = new Types.ObjectId().toString();
  const user = {
    userId: 'u1',
    email: 'admin@erp.local',
    role: 'admin',
    permissions: [PERMISSIONS.ONBOARDING_TEMPLATE],
    sedeIds: [sedeId],
  } as unknown as JwtUser;

  let catalogo: { sku: string; name: string; salePrice: number; ivaRate: number; ivaType: string; tratamientoFiscal?: string }[];
  let inventario: { _id: Types.ObjectId; sku: string; active?: boolean; save?: () => Promise<void> }[];
  let categorias: { _id: Types.ObjectId; name: string; active: boolean; save: () => Promise<void> }[];
  let mesas: { zone: string; name: string }[];
  let entradas: { productId: string; qty: number }[];
  let stockEntry: ReturnType<typeof vi.fn>;
  let productosCreados: Record<string, unknown>[];
  let svc: OnboardingService;
  const dueno = { ...user, role: 'owner' } as unknown as JwtUser;

  const coincide = (sku: string, filtro: any): boolean => {
    if (!filtro?.sku) return true;
    const f = filtro.sku;
    if (f instanceof RegExp) return f.test(sku);
    if (f.$not) return !f.$not.test(sku);
    return sku === f;
  };
  const exec = <T>(v: T) => ({ exec: async () => v });

  function armar() {
    const catalogModel: any = {
      exists: (f: any) => exec(catalogo.some((c) => coincide(c.sku, f)) ? { _id: 1 } : null),
      countDocuments: (f: any) => exec(catalogo.filter((c) => coincide(c.sku, f)).length),
    };
    const productModel: any = {
      findOne: (f: any) => exec(inventario.find((p) => p.sku === f.sku) ?? null),
      countDocuments: (f: any) => exec(inventario.filter((p) => coincide(p.sku, f)).length),
    };
    const categoryModel: any = {
      findOne: (f: any) => exec(categorias.find((c) => c.name === f.name) ?? null),
      create: async (d: { name: string }) => {
        const c = { _id: new Types.ObjectId(), name: d.name, active: true, save: async () => undefined };
        categorias.push(c);
        return c;
      },
    };
    const products: any = {
      create: vi.fn(async (d: { sku: string }) => {
        productosCreados.push(d);
        const p = { _id: new Types.ObjectId(), sku: d.sku, active: true, save: async () => undefined };
        inventario.push(p);
        return p;
      }),
    };
    const catalog: any = {
      create: vi.fn(async (d: any) => {
        catalogo.push({
          sku: d.sku,
          name: d.name,
          salePrice: d.salePrice,
          ivaRate: d.ivaRate,
          ivaType: d.ivaType,
          tratamientoFiscal: d.tratamientoFiscal,
        });
      }),
    };
    stockEntry = vi.fn();
    const sembradas = new Set<string>();
    const stock: any = {
      entry: stockEntry,
      sembrarMuestra: vi.fn(async (d: { productId: string; qty: number }) => {
        if (sembradas.has(d.productId)) return false;
        sembradas.add(d.productId);
        entradas.push({ productId: d.productId, qty: d.qty });
        return true;
      }),
      quitarMuestras: vi.fn(async (ids: string[]) => ids),
    };
    const restaurant: any = {
      listTables: vi.fn(async () => mesas),
      createTable: vi.fn(async (d: { name: string; zone: string }) => {
        mesas.push({ zone: d.zone, name: d.name });
      }),
    };
    const sedes: any = {
      list: vi.fn(async () => [{ _id: new Types.ObjectId(sedeId) }]),
      findOrFail: vi.fn(async () => ({})),
    };
    return new OnboardingService(
      catalogModel,
      productModel,
      categoryModel,
      catalog,
      products,
      stock,
      restaurant,
      sedes,
    );
  }

  const aplicar = (dto: any, giro: 'restaurante' | 'retail' = 'restaurante') =>
    TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio: giro }, () =>
      svc.aplicar(dto, user),
    );

  beforeEach(() => {
    catalogo = [];
    inventario = [];
    categorias = [];
    mesas = [];
    entradas = [];
    productosCreados = [];
    svc = armar();
  });

  it('crea categorías, productos con precio, existencias y mesas', async () => {
    const r = await aplicar({ tipo: 'restaurante' });
    const total = itemsDe(plantillaDe('restaurante')!).length;
    expect(r.productos).toEqual({ creados: total, omitidos: 0 });
    expect(r.categorias).toEqual({ creadas: 4, existentes: 0 });
    expect(r.mesas).toEqual({ creadas: 8, omitidas: 0 });
    expect(catalogo).toHaveLength(total);
    expect(entradas).toHaveLength(total);
    expect(entradas.every((e) => e.qty === r.stockInicial)).toBe(true);
    expect(r.sedeId).toBe(sedeId);
  });

  it('es idempotente: aplicarla dos veces no duplica nada ni exige confirmación', async () => {
    await aplicar({ tipo: 'restaurante' });
    const antes = { c: catalogo.length, i: inventario.length, m: mesas.length, e: entradas.length, k: categorias.length };
    const r2 = await aplicar({ tipo: 'restaurante' });
    expect(r2.productos.creados).toBe(0);
    expect(r2.productos.omitidos).toBe(antes.c);
    expect(r2.categorias).toEqual({ creadas: 0, existentes: 4 });
    expect(r2.mesas).toEqual({ creadas: 0, omitidas: 8 });
    expect({ c: catalogo.length, i: inventario.length, m: mesas.length, e: entradas.length, k: categorias.length }).toEqual(antes);
  });

  it('un reintento completa lo que quedó a medias sin duplicar el inventario', async () => {
    const [primero] = itemsDe(plantillaDe('tienda')!);
    inventario.push({ _id: new Types.ObjectId(), sku: primero!.sku, active: false, save: async () => undefined }); // sobrevivió sin su vendible
    const r = await aplicar({ tipo: 'tienda' }, 'retail');
    expect(inventario.filter((p) => p.sku === primero!.sku)).toHaveLength(1);
    expect(catalogo.some((c) => c.sku === primero!.sku)).toBe(true);
    expect(r.productos.creados).toBe(itemsDe(plantillaDe('tienda')!).length);
  });

  it('rechaza si la empresa ya tiene productos propios, salvo confirmación explícita', async () => {
    catalogo.push({ sku: 'MIO-1', name: 'Mi producto', salePrice: 1000, ivaRate: 19, ivaType: 'gravado' });
    await expect(aplicar({ tipo: 'restaurante' })).rejects.toBeInstanceOf(ConflictException);
    expect(catalogo).toHaveLength(1);

    const r = await aplicar({ tipo: 'restaurante', confirmar: true });
    expect(r.productos.creados).toBeGreaterThan(0);
    expect(catalogo.some((c) => c.sku === 'MIO-1')).toBe(true); // no pisa lo propio
  });

  it('también cuenta como propio un ítem solo de inventario', async () => {
    inventario.push({ _id: new Types.ObjectId(), sku: 'HARINA' });
    await expect(aplicar({ tipo: 'panaderia' }, 'retail')).rejects.toBeInstanceOf(ConflictException);
  });

  it('otra plantilla ya cargada cuenta como productos existentes (pide confirmar)', async () => {
    await aplicar({ tipo: 'cafeteria' });
    await expect(aplicar({ tipo: 'panaderia' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('restaurante: lo servido (incluidas las bebidas) nace sin IVA como expendio (INC en la venta)', async () => {
    const r = await aplicar({ tipo: 'restaurante' });
    const bandeja = catalogo.find((c) => c.name === 'Bandeja paisa')!;
    expect(bandeja).toMatchObject({ salePrice: 28000, ivaRate: 0, ivaType: 'excluido', tratamientoFiscal: 'expendio' });
    const gaseosa = catalogo.find((c) => c.name === 'Gaseosa 400 ml')!;
    expect(gaseosa).toMatchObject({ ivaRate: 0, ivaType: 'excluido', tratamientoFiscal: 'expendio' });
    expect(r.impuestos.conInc + r.impuestos.conIva + r.impuestos.excluidos).toBe(r.productos.creados);
    expect(r.impuestos.conInc).toBe(r.productos.creados);
  });

  it('restaurante con panadería: pastelería, pasteles y bebidas van con INC (art. 512-8); el pan, no', async () => {
    const r = await aplicar({ tipo: 'panaderia' });
    for (const nombre of ['Torta (porción)', 'Pastel de pollo', 'Croissant', 'Roscón', 'Gaseosa 400 ml', 'Jugo en caja', 'Tinto']) {
      expect(catalogo.find((c) => c.name === nombre), nombre).toMatchObject({
        ivaRate: 0,
        ivaType: 'excluido',
        tratamientoFiscal: 'expendio',
      });
    }
    // El pan es un bien excluido que se lleva: sigue como mercancía.
    expect(catalogo.find((c) => c.name === 'Pan francés (unidad)')).toMatchObject({
      ivaType: 'excluido',
      tratamientoFiscal: 'mercancia',
    });
    expect(r.impuestos.conInc).toBe(9);
    expect(catalogo.find((c) => c.name === 'Leche entera 1 L')).toMatchObject({ ivaRate: 0, ivaType: 'exento' });
  });

  it('retail: el IVA del bien, sin INC ni mesas', async () => {
    const r = await aplicar({ tipo: 'tienda' }, 'retail');
    expect(catalogo.find((c) => c.name === 'Arroz 1 kg')).toMatchObject({ ivaRate: 0, ivaType: 'excluido' });
    expect(catalogo.find((c) => c.name === 'Café molido 250 g')).toMatchObject({ ivaRate: 5, ivaType: 'gravado' });
    expect(catalogo.find((c) => c.name === 'Detergente 1 kg')).toMatchObject({ ivaRate: 19 });
    expect(catalogo.every((c) => c.tratamientoFiscal === undefined)).toBe(true);
    expect(r.impuestos.conInc).toBe(0);
    expect(r.mesas).toEqual({ creadas: 0, omitidas: 0 });
  });

  it('H1: aplicar la plantilla no deja NINGÚN movimiento con costo (ni una compra)', async () => {
    await aplicar({ tipo: 'restaurante' });
    await aplicar({ tipo: 'restaurante' });
    // Nada entra por la vía de compra (`entry`, que lleva costo y valoriza)...
    expect(stockEntry).not.toHaveBeenCalled();
    // ... los ítems nacen sin costo, para que la valorización no invente valor...
    expect(productosCreados.length).toBeGreaterThan(0);
    expect(productosCreados.every((p) => !('cost' in p) || p.cost === 0 || p.cost === undefined)).toBe(true);
    // ... y las existencias son de ejemplo (movimiento `sample`, sin costo).
    expect(entradas.every((e) => e.qty === 30)).toBe(true);
  });

  it('M3: una empresa retail no puede cargar restaurante, cafetería ni comidas rápidas', async () => {
    for (const tipo of ['restaurante', 'cafeteria', 'comidas_rapidas']) {
      await expect(aplicar({ tipo }, 'retail')).rejects.toThrow(/retail/);
    }
    expect(catalogo).toHaveLength(0);
    expect(mesas).toHaveLength(0);
  });

  it('M3: panadería en retail no siembra lo servido y lo avisa', async () => {
    const r = await aplicar({ tipo: 'panaderia' }, 'retail');
    const total = itemsDe(plantillaDe('panaderia')!).length;
    expect(r.omitidosPorGiro).toBe(2);
    // La pastelería sí se siembra en retail, con su IVA.
    expect(catalogo.find((c) => c.name === 'Croissant')).toMatchObject({ ivaRate: 19, ivaType: 'gravado' });
    expect(r.productos.creados).toBe(total - 2);
    expect(catalogo.some((c) => c.name === 'Tinto')).toBe(false);
    expect(r.aviso).toMatch(/restaurante/);
  });

  it('M4: estado cuenta como ajenos los productos de OTRAS plantillas (la UI pide confirmar)', async () => {
    await aplicar({ tipo: 'cafeteria' });
    const e = await TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'restaurante' }, () =>
      svc.estado(),
    );
    const cafe = e.plantillas.find((p) => p.tipo === 'cafeteria')!;
    const pan = e.plantillas.find((p) => p.tipo === 'panaderia')!;
    expect(cafe.ajenos).toBe(0);
    expect(pan.ajenos).toBe(itemsDe(plantillaDe('cafeteria')!).length);
    expect(e.productosPropios).toBe(0);
  });

  it('M4: estado marca qué plantillas no aplican a una empresa retail', async () => {
    const e = await TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'retail' }, () =>
      svc.estado(),
    );
    expect(e.plantillas.filter((p) => !p.aplica).map((p) => p.tipo).sort()).toEqual([
      'cafeteria',
      'comidas_rapidas',
      'restaurante',
    ]);
    expect(e.plantillas.find((p) => !p.aplica)!.motivo).toMatch(/retail/);
  });

  it('L2: un SKU «PL-XYZ-01» del usuario cuenta como producto propio', async () => {
    catalogo.push({ sku: 'PL-XYZ-01', name: 'Mío', salePrice: 1000, ivaRate: 19, ivaType: 'gravado' });
    await expect(aplicar({ tipo: 'tienda' }, 'retail')).rejects.toBeInstanceOf(ConflictException);
  });

  it('quitar datos de ejemplo exige ver todas las sedes: un admin de una sola sede recibe 403', async () => {
    await aplicar({ tipo: 'tienda' }, 'retail');
    await expect(svc.quitar('tienda', user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(catalogo.length).toBeGreaterThan(0);
  });

  it('quitar datos de ejemplo: retira vendibles y desactiva el inventario', async () => {
    await aplicar({ tipo: 'tienda' }, 'retail');
    const total = catalogo.length;
    (svc as any).catalog.remove = vi.fn(async () => undefined);
    (svc as any).catalogModel.findOne = (f: any) => ({
      exec: async () => (catalogo.some((c) => c.sku === f.sku) ? { _id: new Types.ObjectId() } : null),
    });
    (svc as any).productModel.find = () => ({ exec: async () => inventario });
    const r = await TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'retail' }, () =>
      svc.quitar('tienda', dueno),
    );
    expect(r).toEqual({ vendiblesQuitados: total, inventarioDesactivado: total, conservados: 0 });
    expect(inventario.every((p) => p.active === false)).toBe(true);
  });

  it('todo precio guardado es un peso entero', async () => {
    await aplicar({ tipo: 'panaderia' }, 'retail');
    expect(catalogo.every((c) => Number.isInteger(c.salePrice) && c.salePrice > 0)).toBe(true);
  });

  it('sin sede a la que tenga acceso, avisa en vez de fallar a medias', async () => {
    (svc as any).sedes.list = vi.fn(async () => []);
    await expect(aplicar({ tipo: 'tienda' }, 'retail')).rejects.toBeInstanceOf(BadRequestException);
    expect(catalogo).toHaveLength(0);
  });

  it('una sede ajena se rechaza antes de tocar nada', async () => {
    await expect(
      aplicar({ tipo: 'tienda', sedeId: new Types.ObjectId().toString() }, 'retail'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(catalogo).toHaveLength(0);
  });

  it('sin giro conocido no adivina el impuesto', async () => {
    await expect(
      TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, () => svc.aplicar({ tipo: 'tienda' } as any, user)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('estado: cuenta productos propios sin contar los de plantilla', async () => {
    await aplicar({ tipo: 'tienda' }, 'retail');
    const e = await TenantContext.run({ businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'retail' }, () =>
      svc.estado(),
    );
    expect(e.productosPropios).toBe(0);
    expect(e.plantillas.find((p) => p.tipo === 'tienda')!.cargados).toBe(
      itemsDe(plantillaDe('tienda')!).length,
    );
    expect(e.tipoNegocio).toBe('retail');
  });
});

describe('permisos de /onboarding (deny-by-default)', () => {
  const llave = (metodo: keyof OnboardingController) =>
    Reflect.getMetadata(PERMISSIONS_KEY, OnboardingController.prototype[metodo]);

  it('ambos handlers exigen onboarding.template', () => {
    expect(llave('estado')).toEqual([PERMISSIONS.ONBOARDING_TEMPLATE]);
    expect(llave('aplicar')).toEqual([PERMISSIONS.ONBOARDING_TEMPLATE]);
  });

  it('solo Dueño y Administrador lo reciben; Gerente y Cajero no', () => {
    const tiene = (key: string) =>
      SYSTEM_ROLES.find((r) => r.key === key)!.permissions.includes(PERMISSIONS.ONBOARDING_TEMPLATE);
    expect(tiene('owner')).toBe(true);
    expect(tiene('admin')).toBe(true);
    expect(tiene('manager')).toBe(false);
    expect(tiene('cashier')).toBe(false);
  });
});
