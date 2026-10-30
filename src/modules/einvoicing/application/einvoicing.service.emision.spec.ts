import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

// Los esquemas se importan por el servicio; se neutralizan los decoradores
// (SWC emite `Object` para uniones de literales). Patrón de
// `orders.service.checkout.spec.ts`.
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

import { EinvoicingService } from './einvoicing.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Qué pasa cuando el índice único `consecutivo_unico` (o el de venta+tipo)
 * rechaza la inserción: el cupo vuelve, el folio no se pierde y el consecutivo
 * se repara. Constructor: (model, counters, sales, sedes, businesses, emisores).
 */
describe('EinvoicingService · emisión frente a choques del índice', () => {
  const sedeId = new Types.ObjectId().toString();
  const saleId = new Types.ObjectId();
  const user = { email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [sedeId] } as unknown as JwtUser;

  const choque = (keyPattern: Record<string, number>) =>
    Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern });
  const choqueNumero = () => choque({ 'emisor.nitNorm': 1, prefix: 1, number: 1 });
  const choqueVenta = () => choque({ saleId: 1, type: 1 });

  let seq: number;
  let mayorEmitido: number;
  let existente: unknown;
  let model: any;
  let counters: any;
  let businesses: any;
  let sedes: any;
  let sales: any;
  let svc: EinvoicingService;

  const sede = () => ({
    id: sedeId,
    nit: '900.123.456-7',
    resolucionFe: {
      prefijo: 'FE',
      rangoDesde: 1,
      rangoHasta: 1000,
      claveTecnica: 'clave',
    },
    resolucionesFe: [],
  });
  const sale = () => ({
    _id: saleId,
    sedeId,
    status: 'paid',
    lines: [],
    payment: { method: 'cash' },
    // Sin líneas: el documento suma 0 y tiene que coincidir con lo cobrado.
    total: 0,
  });

  const emitir = () =>
    TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, () =>
      svc.createFromSale(saleId.toString(), user),
    );

  beforeEach(() => {
    seq = 0;
    mayorEmitido = 0;
    existente = null;
    const cadena = (q: any) => {
      const c: any = {
        sort: () => c,
        select: () => c,
        lean: () => c,
        exec: () => Promise.resolve(q?.$or ? (mayorEmitido ? { number: mayorEmitido } : null) : existente),
      };
      return c;
    };
    model = { findOne: vi.fn(cadena), create: vi.fn(async (d: any) => ({ ...d, _id: 'doc' })) };
    counters = {
      findOneAndUpdate: vi.fn((filtro: any, upd: any) => ({
        exec: async () => {
          if (upd.$inc?.seq === 1) {
            seq += 1;
            return { seq };
          }
          if (upd.$inc?.seq === -1) {
            if (filtro.seq === seq) seq -= 1;
            return { seq };
          }
          if (upd.$max) seq = Math.max(seq, upd.$max.seq);
          return { seq };
        },
      })),
    };
    businesses = {
      consumeDocument: vi.fn(async () => 'monthly'),
      refundDocument: vi.fn(async () => undefined),
      findById: vi.fn(async () => null),
    };
    sedes = { findOrFail: vi.fn(async () => sede()) };
    sales = { getOrFail: vi.fn(async () => sale()) };
    svc = new EinvoicingService(model, counters, sales, sedes, businesses, {
      obtenerPorSede: async () => null,
    } as any);
  });

  it('sin choque: cobra el cupo una vez y guarda el NIT normalizado', async () => {
    await emitir();
    expect(businesses.consumeDocument).toHaveBeenCalledTimes(1);
    expect(businesses.refundDocument).not.toHaveBeenCalled();
    expect(model.create.mock.calls[0][0].emisor.nitNorm).toBe('900123456');
  });

  it('choque por número: devuelve el cupo, sube el contador al mayor emitido y reintenta', async () => {
    mayorEmitido = 40;
    model.create
      .mockImplementationOnce(async () => {
        throw choqueNumero();
      })
      .mockImplementation(async (d: any) => ({ ...d, _id: 'doc' }));
    const doc: any = await emitir();
    expect(businesses.consumeDocument).toHaveBeenCalledTimes(2);
    expect(businesses.refundDocument).toHaveBeenCalledTimes(1);
    expect(doc.number).toBe(41);
  });

  it('choque por número 3 veces: se rinde con 409 y deja el cupo devuelto', async () => {
    mayorEmitido = 5;
    model.create.mockImplementation(async () => {
      throw choqueNumero();
    });
    await expect(emitir()).rejects.toBeInstanceOf(ConflictException);
    expect(model.create).toHaveBeenCalledTimes(3);
    expect(businesses.refundDocument).toHaveBeenCalledTimes(3);
    expect(businesses.consumeDocument).toHaveBeenCalledTimes(3);
  });

  it('choque por venta+tipo (doble emisión): devuelve el existente, el cupo y el folio', async () => {
    existente = { _id: 'ya-estaba', number: 1 };
    // El primero de la carrera no existía cuando se revisó; ahora sí.
    let primera = true;
    model.findOne.mockImplementation((q: any) => {
      const valor = q?.$or ? null : primera ? ((primera = false), null) : existente;
      const c: any = { sort: () => c, select: () => c, lean: () => c, exec: () => Promise.resolve(valor) };
      return c;
    });
    model.create.mockImplementation(async () => {
      throw choqueVenta();
    });
    const doc = await emitir();
    expect(doc).toBe(existente);
    expect(businesses.refundDocument).toHaveBeenCalledTimes(1);
    expect(seq).toBe(0); // el folio tomado volvió al contador
  });

  it('error que no es del índice: relanza, con cupo y folio devueltos', async () => {
    model.create.mockImplementation(async () => {
      throw new Error('boom');
    });
    await expect(emitir()).rejects.toThrow('boom');
    expect(businesses.refundDocument).toHaveBeenCalledTimes(1);
    expect(seq).toBe(0);
  });

  it('sin cupo: 402 sin tocar el contador', async () => {
    businesses.consumeDocument.mockRejectedValue(new Error('402'));
    await expect(emitir()).rejects.toThrow('402');
    expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    expect(businesses.refundDocument).not.toHaveBeenCalled();
  });
});

describe('EinvoicingService.registerResolution · número inicial y prefijo', () => {
  const sedeId = new Types.ObjectId().toString();
  const user = { email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [sedeId] } as unknown as JwtUser;
  let mayor: number;
  let seqFijado: number | undefined;
  let guardada: any;
  let svc: EinvoicingService;

  beforeEach(() => {
    mayor = 0;
    seqFijado = undefined;
    guardada = undefined;
    const sedeDoc: any = {
      id: sedeId,
      code: 'S1',
      name: 'Sede',
      nit: '900123456-7',
      resolucionFe: undefined,
      resolucionesFe: [],
      save: vi.fn(async () => undefined),
    };
    const c = (v: unknown): any => {
      const o: any = { sort: () => o, select: () => o, lean: () => o, exec: () => Promise.resolve(v) };
      return o;
    };
    const model: any = { findOne: vi.fn(() => c(mayor ? { number: mayor } : null)) };
    const counters: any = {
      findOneAndUpdate: vi.fn((_f: unknown, u: any) => {
        seqFijado = u.$set.seq;
        return c(null);
      }),
      findById: vi.fn(() => c(null)),
    };
    const sedes: any = {
      findOrFail: vi.fn(async () => sedeDoc),
      list: vi.fn(async () => []),
    };
    svc = new EinvoicingService(model, counters, {} as any, sedes, {} as any, {} as any);
    guardada = sedeDoc;
  });

  it('por defecto arranca en el mayor emitido + 1 (o en el inicio del rango si es mayor)', async () => {
    mayor = 500;
    await svc.registerResolution(sedeId, { prefijo: 'fe', rangoDesde: 1, rangoHasta: 2000 }, user);
    expect(seqFijado).toBe(500); // próximo número = 501
    mayor = 500;
    await svc.registerResolution(sedeId, { prefijo: 'fe', rangoDesde: 2001, rangoHasta: 4000 }, user);
    expect(seqFijado).toBe(0); // arranca en 2001
  });

  it('rechaza un empezarEn que ya fue emitido, con el último en el mensaje', async () => {
    mayor = 500;
    await expect(
      svc.registerResolution(sedeId, { prefijo: 'FE', rangoDesde: 1, rangoHasta: 2000, empezarEn: 500 }, user),
    ).rejects.toThrow(/último fue el 500/);
    expect(guardada.save).not.toHaveBeenCalled();
  });

  it('acepta un empezarEn posterior al último emitido', async () => {
    mayor = 500;
    await svc.registerResolution(sedeId, { prefijo: 'FE', rangoDesde: 1, rangoHasta: 2000, empezarEn: 600 }, user);
    expect(seqFijado).toBe(599);
  });

  it('los tipos distintos de factura exigen prefijo', async () => {
    await expect(
      svc.registerResolution(sedeId, { tipoDocumento: 'pos', rangoDesde: 1, rangoHasta: 10 }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    await svc.registerResolution(sedeId, { tipoDocumento: 'pos', prefijo: 'pos', rangoDesde: 1, rangoHasta: 10 }, user);
    expect(guardada.resolucionesFe[0]).toMatchObject({ tipoDocumento: 'pos', prefijo: 'POS' });
  });

  it('la factura puede seguir sin prefijo', async () => {
    await svc.registerResolution(sedeId, { rangoDesde: 1, rangoHasta: 10 }, user);
    expect(guardada.resolucionFe.tipoDocumento).toBe('invoice');
  });
});
