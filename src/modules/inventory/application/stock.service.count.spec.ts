import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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

import { StockService } from './stock.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Conteo físico masivo: la planilla del domingo al cerrar.
 *
 * La regla que lo define, y la que hace que esto no se pudiera resolver con el
 * endpoint de carga de existencias que ya existía: un conteo NO suma, FIJA.
 * "Aquí hay 40" contra un sistema que creía 47 son siete de menos, no cuarenta
 * de más. Usar `stock/import` para contar duplicaba el inventario, y encima no
 * avisaba: quedaba un número más grande, que es justo lo que uno espera ver
 * después de contar.
 *
 * Lo otro que se protege es que la planilla es larga y se llena a mano: un
 * producto que no se pueda ajustar no puede tumbar los otros ciento veinte.
 */
describe('StockService.applyCount · el conteo fija, no suma', () => {
  const sedeId = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'bodeguero@bookipos.local',
    name: 'Bodeguero',
    role: 'manager',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let service: StockService;
  let ajustes: any[];
  let existencias: Map<string, number>;

  function producto(opts: {
    name: string;
    cost?: number;
    perishable?: boolean;
  }) {
    return {
      _id: new Types.ObjectId(),
      name: opts.name,
      unit: 'und',
      active: true,
      cost: opts.cost ?? 0,
      perishable: opts.perishable ?? false,
      trackLots: false,
    };
  }

  /**
   * Arma el servicio con `adjust` espiado: lo que importa aquí es QUÉ ajuste se
   * pide (signo y cantidad), no cómo lo ejecuta el primitivo de stock, que ya
   * tiene sus propias pruebas.
   */
  function build(productos: any[]) {
    const porId = new Map(productos.map((p) => [p._id.toString(), p]));
    ajustes = [];

    const stockItemModel = {
      findOne: vi.fn((filter: any) => ({
        exec: () => {
          const qty = existencias.get(filter.productId.toString());
          return Promise.resolve(qty === undefined ? null : { qty });
        },
      })),
    };

    service = new StockService(
      stockItemModel as never,
      {} as never,
      {} as never,
      { connectionFor: () => ({ transaction: (cb: any) => cb(undefined) }) } as never,
      {
        getOrFail: vi.fn((id: string) => {
          const p = porId.get(id);
          if (!p) return Promise.reject(new Error('No existe el producto'));
          return Promise.resolve(p);
        }),
      } as never,
      { findOrFail: vi.fn().mockResolvedValue({ _id: sedeId }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    vi.spyOn(service, 'adjust').mockImplementation(((dto: any) => {
      ajustes.push(dto);
      return Promise.resolve({} as never);
    }) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    existencias = new Map();
  });

  it('contar 40 donde el sistema creía 47 resta siete: NO suma cuarenta', async () => {
    const harina = producto({ name: 'Harina', cost: 3_000 });
    build([harina]);
    existencias.set(harina._id.toString(), 47);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: harina._id.toString(), counted: 40 }],
      } as never,
      user,
    );

    expect(ajustes).toHaveLength(1);
    expect(ajustes[0].direction).toBe('remove');
    expect(ajustes[0].qty).toBe(7);
    expect(ajustes[0].reason).toBe('conteo');
    expect(res.adjusted).toBe(1);
    expect(res.removedQty).toBe(7);
    // Siete bolsas a $3.000: lo que se perdió, en plata.
    expect(res.removedValue).toBe(21_000);
  });

  it('contar de más suma la diferencia, no el total contado', async () => {
    const vasos = producto({ name: 'Vasos', cost: 500 });
    build([vasos]);
    existencias.set(vasos._id.toString(), 10);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: vasos._id.toString(), counted: 12 }],
      } as never,
      user,
    );

    expect(ajustes[0].direction).toBe('add');
    expect(ajustes[0].qty).toBe(2);
    expect(res.addedQty).toBe(2);
    expect(res.addedValue).toBe(1_000);
  });

  it('lo que ya cuadra no genera movimiento: el kardex no se ensucia', async () => {
    const sal = producto({ name: 'Sal' });
    build([sal]);
    existencias.set(sal._id.toString(), 25);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: sal._id.toString(), counted: 25 }],
      } as never,
      user,
    );

    expect(ajustes).toHaveLength(0);
    expect(res.unchanged).toBe(1);
    expect(res.adjusted).toBe(0);
  });

  it('contar cero deja la existencia en cero: se acabó de verdad', async () => {
    const levadura = producto({ name: 'Levadura', cost: 8_000 });
    build([levadura]);
    existencias.set(levadura._id.toString(), 3);

    await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: levadura._id.toString(), counted: 0 }],
      } as never,
      user,
    );

    expect(ajustes[0].direction).toBe('remove');
    expect(ajustes[0].qty).toBe(3);
  });

  it('un producto que nunca entró a la sede parte de cero, no falla', async () => {
    // Aparece en el estante algo que el sistema no tenía registrado ahí. Sin
    // fila de existencias, `findOne` devuelve null: eso es un cero legítimo.
    const servilletas = producto({ name: 'Servilletas', cost: 100 });
    build([servilletas]);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: servilletas._id.toString(), counted: 8 }],
      } as never,
      user,
    );

    expect(ajustes[0].direction).toBe('add');
    expect(ajustes[0].qty).toBe(8);
    expect(res.errors).toHaveLength(0);
  });

  it('una fila que falla no tumba el resto de la planilla', async () => {
    const buena = producto({ name: 'Azúcar', cost: 2_000 });
    build([buena]);
    existencias.set(buena._id.toString(), 10);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [
          { productId: new Types.ObjectId().toString(), counted: 5 }, // borrado
          { productId: buena._id.toString(), counted: 7 },
        ],
      } as never,
      user,
    );

    expect(res.errors).toHaveLength(1);
    expect(res.adjusted).toBe(1);
    expect(ajustes).toHaveLength(1);
    expect(ajustes[0].qty).toBe(3);
  });

  it('un perecedero que aparece de más se devuelve con motivo, sin romper el FEFO', async () => {
    // No hay de dónde sacar el vencimiento en una planilla, y un lote sin
    // fecha se saltaría el orden de salida. Se reporta para registrarlo como
    // entrada de verdad.
    const leche = producto({ name: 'Leche', perishable: true, cost: 4_000 });
    build([leche]);
    existencias.set(leche._id.toString(), 6);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: leche._id.toString(), counted: 9 }],
      } as never,
      user,
    );

    expect(ajustes).toHaveLength(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.message).toMatch(/perecedero/i);
    expect(res.errors[0]!.name).toBe('Leche');
  });

  it('un perecedero que falta sí se ajusta: sale por FEFO como cualquier salida', async () => {
    const leche = producto({ name: 'Leche', perishable: true, cost: 4_000 });
    build([leche]);
    existencias.set(leche._id.toString(), 6);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: leche._id.toString(), counted: 4 }],
      } as never,
      user,
    );

    expect(ajustes[0].direction).toBe('remove');
    expect(ajustes[0].qty).toBe(2);
    expect(res.errors).toHaveLength(0);
  });

  it('avisa si algo se movió mientras se contaba, y aplica igual lo del estante', async () => {
    // Se generó la planilla con 47, alguien vendió 2 y quedó en 45. La verdad
    // sigue siendo el estante: quedan 40. Pero la fila se reporta para que
    // alguien mire si esa venta se contó dos veces.
    const harina = producto({ name: 'Harina', cost: 3_000 });
    build([harina]);
    existencias.set(harina._id.toString(), 45);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: harina._id.toString(), counted: 40, expected: 47 }],
      } as never,
      user,
    );

    expect(res.moved).toEqual([
      {
        productId: harina._id.toString(),
        name: 'Harina',
        expected: 47,
        actual: 45,
      },
    ]);
    expect(ajustes[0].qty).toBe(5); // contra lo que hay AHORA, no contra 47
  });

  it('la nota del conteo viaja a cada movimiento del kardex', async () => {
    const harina = producto({ name: 'Harina' });
    build([harina]);
    existencias.set(harina._id.toString(), 10);

    await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: harina._id.toString(), counted: 8 }],
        note: 'Conteo del domingo 12',
      } as never,
      user,
    );

    expect(ajustes[0].note).toBe('Conteo del domingo 12');
  });

  it('ignora diferencias por debajo del redondeo de la balanza', async () => {
    // Los insumos se miden en gramos: 0,0001 g de diferencia es la balanza, no
    // el inventario. Ajustarlo llenaría el kardex de ruido.
    const harina = producto({ name: 'Harina' });
    build([harina]);
    existencias.set(harina._id.toString(), 1000);

    const res = await service.applyCount(
      {
        sedeId: sedeId.toString(),
        rows: [{ productId: harina._id.toString(), counted: 1000.0001 }],
      } as never,
      user,
    );

    expect(ajustes).toHaveLength(0);
    expect(res.unchanged).toBe(1);
  });
});
