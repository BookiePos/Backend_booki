import { NotFoundException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

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

// La transmisión va detrás de la respuesta: aquí se captura para esperarla.
const enSegundoPlano: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => void enSegundoPlano.push(p),
}));

import { SaleReturnsService } from './sale-returns.service';
import { NotaFiscalVentaService, MENSAJE_NOTA_CONTINGENCIA } from './nota-fiscal-venta.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * La devolución con su nota fiscal (Fase 6B): la nota lleva los MISMOS
 * valores que el libro, se emite antes de mover nada (si falla no se mueve
 * nada), se transmite detrás sin bloquear la caja, el reintento con la misma
 * llave no duplica nada, y en una venta fiada baja la cartera en vez de sacar
 * plata.
 */
describe('SaleReturnsService · nota fiscal y fiado (Fase 6B)', () => {
  const sedeId = new Types.ObjectId();
  const saleId = new Types.ObjectId();
  const HAMB = new Types.ObjectId();
  const GAS = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    role: 'cashier',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as unknown as JwtUser;

  /** 3 hamburguesas con INC ($30.000) y 2 gaseosas con IVA ($10.000). */
  function venta(o: Record<string, unknown> = {}) {
    return {
      _id: saleId,
      saleNumber: 'FV-000123',
      sedeId: { _id: sedeId },
      status: 'completed',
      payment: { method: 'cash' },
      lines: [
        { productId: HAMB, sku: 'H1', name: 'Hamburguesa', qty: 3, taxKind: 'inc', taxBase: 27_778, taxAmount: 2_222 },
        { productId: GAS, sku: 'G1', name: 'Gaseosa', qty: 2, taxKind: 'iva', taxBase: 8_403, taxAmount: 1_597 },
      ],
      components: [
        { productId: HAMB, qty: 3, cost: 12_000, consumedLots: [] },
        { productId: GAS, qty: 2, cost: 4_000, consumedLots: [] },
      ],
      ...o,
    };
  }

  let service: SaleReturnsService;
  let registros: any[];
  let model: any;
  let stock: any;
  let caja: any;
  let ledger: any;
  let receivables: any;
  let cxc: any;
  let puerto: any;
  let orden: string[];

  function build(sale: any = venta(), conNotas = true) {
    registros = [];
    orden = [];
    model = {
      find: vi.fn((f: any = {}) => {
        const filtrados = () =>
          registros.filter(
            (r) =>
              (!f.estado || r.estado === f.estado) &&
              (!f.createdAt || (r.createdAt && r.createdAt < f.createdAt.$lt)) &&
              (!f.$or || !r.procesandoHasta || r.procesandoHasta < new Date()),
          );
        return {
          sort: () => ({ exec: async () => filtrados(), limit: () => ({ exec: async () => filtrados() }) }),
          exec: async () => filtrados(),
        };
      }),
      findOne: vi.fn((f: any) => ({
        exec: async () => registros.find((r) => r.idempotencyKey && r.idempotencyKey === f.idempotencyKey) ?? null,
      })),
      create: vi.fn(async (d: any) => {
        const r = { ...d, _id: new Types.ObjectId(), save: vi.fn(async () => undefined) };
        registros.push(r);
        return r;
      }),
      // Turno atómico (N1): lo toma quien encuentre la devolución en curso y
      // sin turno vigente, como el `findOneAndUpdate` condicionado de Mongo.
      findOneAndUpdate: vi.fn((f: any, upd: any) => ({
        exec: async () => {
          const r = registros.find((x) => String(x._id) === String(f._id));
          if (!r || !(f.estado?.$in ?? [f.estado]).includes(r.estado)) return null;
          if (r.procesandoHasta && r.procesandoHasta >= new Date()) return null;
          Object.assign(r, upd.$set);
          return r;
        },
      })),
      updateOne: vi.fn((f: any, upd: any) => ({
        exec: async () => {
          const r = registros.find((x) => String(x._id) === String(f._id));
          // Condicionado al turno propio (N5), como el filtro de Mongo.
          if ('procesandoHasta' in f && r?.procesandoHasta?.getTime?.() !== f.procesandoHasta?.getTime?.()) {
            return {};
          }
          if (r) Object.assign(r, upd.$set);
          return {};
        },
      })),
      findById: vi.fn((id: any) => ({
        exec: async () => registros.find((x) => String(x._id) === String(id)) ?? null,
      })),
      deleteOne: vi.fn((f: any) => ({
        exec: async () => {
          registros = registros.filter((r) => String(r._id) !== String(f._id));
          return { deletedCount: 1 };
        },
      })),
    };
    stock = {
      reverseSale: vi.fn(async () => void orden.push('stock')),
      adjust: vi.fn(async () => undefined),
    };
    caja = { movement: vi.fn(async () => void orden.push('caja')) };
    ledger = { postSaleReturn: vi.fn(async () => void orden.push('libro')) };
    cxc = null;
    receivables = {
      findOne: vi.fn(() => ({ exec: async () => cxc })),
      findOneAndUpdate: vi.fn((f: any, upd: any) => ({
        exec: async () => {
          if (!cxc) return null;
          if (f.amount !== undefined && (f.amount !== cxc.amount || f.paidAmount !== cxc.paidAmount)) return null;
          cxc = { ...cxc, amount: cxc.amount + upd.$inc.amount, status: upd.$set?.status ?? cxc.status };
          orden.push('cartera');
          return cxc;
        },
      })),
      updateOne: vi.fn(() => ({ exec: async () => ({}) })),
    };
    puerto = {
      emitirNota: vi.fn(async (s: any) => {
        orden.push('nota');
        return {
          estado: 'emitida',
          documentoId: 'nota-1',
          fullNumber: 'NC1',
          referenceType: 'invoice',
          concepto: s.concepto,
          dianStatus: 'draft',
        };
      }),
      transmitir: vi.fn(async () => undefined),
    };
    const notas = new NotaFiscalVentaService({ get: () => puerto } as never);
    service = new SaleReturnsService(
      model as never,
      { getOrFail: vi.fn(async () => sale) } as never,
      stock as never,
      {
        loadSellableOrFail: vi.fn(async (id: string) => ({ _id: id })),
        componentsOf: vi.fn((p: { _id: string }, qty: number) => [{ productId: String(p._id), qty }]),
      } as never,
      caja as never,
      ledger as never,
      receivables as never,
      conNotas ? notas : undefined,
    );
  }

  const devolucion = (extra: Record<string, unknown> = {}) =>
    ({
      lines: [{ productId: HAMB.toString(), qty: 1 }, { productId: GAS.toString(), qty: 1 }],
      reason: 'defectuoso',
      restock: 'inventory',
      refundMethod: 'cash',
      ...extra,
    }) as never;

  beforeEach(() => {
    enSegundoPlano.length = 0;
  });

  describe('propina en la devolución parcial (decisión 4)', () => {
    it('vuelve en proporción: va en la nota como cargo, sale de la caja y del libro (2380)', async () => {
      // Vendido $40.000 con $4.000 de propina; se devuelven $15.000 → $1.500.
      build(venta({ tip: 4_000 }));
      const r: any = await service.create(saleId.toString(), devolucion(), user);
      expect(r.refundTotal).toBe(15_000);
      expect(r.tipRefund).toBe(1_500);
      expect(puerto.emitirNota.mock.calls[0][0].propina).toBe(1_500);
      expect(caja.movement.mock.calls[0][0].amount).toBe(16_500);
      const asiento = ledger.postSaleReturn.mock.calls[0][0];
      expect(asiento.refundTotal).toBe(15_000);
      expect(asiento.tip).toBe(1_500);
    });

    it('devuelto todo en dos veces, vuelve la propina entera (redondeo acumulado)', async () => {
      build(venta({ tip: 3_333 }));
      await service.create(saleId.toString(), devolucion(), user);
      await service.create(
        saleId.toString(),
        devolucion({ lines: [{ productId: HAMB.toString(), qty: 2 }, { productId: GAS.toString(), qty: 1 }] }),
        user,
      );
      expect(registros.reduce((t, x) => t + x.tipRefund, 0)).toBe(3_333);
    });

    it('el fiado entero no registró propina: no devuelve propina', async () => {
      build(venta({ tip: 4_000, payment: { method: 'credit' } }));
      cxc = { _id: new Types.ObjectId(), amount: 40_000, paidAmount: 0, status: 'open' };
      const r: any = await service.create(saleId.toString(), devolucion(), user);
      expect(r.tipRefund).toBe(0);
      expect(ledger.postSaleReturn.mock.calls[0][0].tip).toBe(0);
    });
  });

  it('emite la nota con los valores del libro, ANTES de mover stock, caja y libro', async () => {
    build();
    const r: any = await service.create(saleId.toString(), devolucion(), user);
    expect(orden).toEqual(['nota', 'stock', 'caja', 'libro']);
    const [s] = puerto.emitirNota.mock.calls[0];
    expect(s.origen).toBe(`devolucion:${String(r._id)}`);
    expect(s.concepto).toBe('1');
    expect(s.motivo).toMatch(/Devolución de la venta FV-000123 \(producto defectuoso\)/);
    // Los mismos `refund`/`refundTax` que van al asiento: DIAN y libro dicen lo mismo.
    expect(s.lineas).toEqual([
      { productId: HAMB.toString(), qty: 1, valor: 10_000, impuesto: 741 },
      { productId: GAS.toString(), qty: 1, valor: 5_000, impuesto: 799 },
    ]);
    const asiento = ledger.postSaleReturn.mock.calls[0][0];
    expect(asiento.refundTotal).toBe(15_000);
    expect(asiento.tax).toBe(799);
    expect(asiento.consumptionTax).toBe(741);
    expect(r.notaFiscal).toMatchObject({ estado: 'emitida', fullNumber: 'NC1' });
    await Promise.all(enSegundoPlano);
    expect(puerto.transmitir).toHaveBeenCalledWith('nota-1', user);
  });

  it('si la nota falla (tope, PIN…), la devolución se retira y no se mueve nada', async () => {
    build();
    puerto.emitirNota.mockRejectedValue(new ConflictException('excede lo que queda por acreditar'));
    await expect(service.create(saleId.toString(), devolucion(), user)).rejects.toBeInstanceOf(ConflictException);
    expect(registros).toHaveLength(0);
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(caja.movement).not.toHaveBeenCalled();
    expect(ledger.postSaleReturn).not.toHaveBeenCalled();
  });

  it('un fallo de la DIAN al transmitir no deja la devolución a medias', async () => {
    build();
    puerto.transmitir.mockRejectedValue(new Error('DIAN caída'));
    const r: any = await service.create(saleId.toString(), devolucion(), user);
    expect(orden).toEqual(['nota', 'stock', 'caja', 'libro']);
    expect(r.notaFiscal.estado).toBe('emitida');
    await expect(Promise.all(enSegundoPlano)).resolves.toBeDefined();
  });

  it('venta sin documento fiscal: la devolución sigue y queda dicho que no lleva nota', async () => {
    build();
    puerto.emitirNota.mockResolvedValue({ estado: 'sin_nota', motivo: 'La venta no tiene documento electrónico' });
    const r: any = await service.create(saleId.toString(), devolucion(), user);
    expect(r.notaFiscal).toEqual({ estado: 'sin_nota', motivo: 'La venta no tiene documento electrónico' });
    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    await Promise.all(enSegundoPlano);
    expect(puerto.transmitir).not.toHaveBeenCalled();
  });

  it('POS anónimo pendiente de contingencia: sin nota, con el motivo de la contingencia', async () => {
    build(venta({ documentoFiscal: { solicitado: 'pos_anonimo', estado: 'pendiente_contingencia_07' } }));
    puerto.emitirNota.mockResolvedValue({ estado: 'sin_nota', motivo: 'x' });
    const r: any = await service.create(saleId.toString(), devolucion(), user);
    expect(r.notaFiscal.motivo).toBe(MENSAJE_NOTA_CONTINGENCIA);
  });

  it('documento todavía emitiéndose: 409 y no se mueve nada', async () => {
    build(venta({ documentoFiscal: { solicitado: 'fev', estado: 'en_proceso' } }));
    puerto.emitirNota.mockResolvedValue({ estado: 'sin_nota', motivo: 'x' });
    await expect(service.create(saleId.toString(), devolucion(), user)).rejects.toBeInstanceOf(ConflictException);
    expect(stock.reverseSale).not.toHaveBeenCalled();
  });

  it('reintento con la misma llave: devuelve la misma devolución, sin otra nota ni otro movimiento', async () => {
    build();
    const a: any = await service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-1' }), user);
    const b: any = await service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-1' }), user);
    expect(b).toBe(a);
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(puerto.emitirNota).toHaveBeenCalledTimes(1);
    expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    expect(caja.movement).toHaveBeenCalledTimes(1);
  });

  it('reintento de una devolución cuya nota no alcanzó a quedar: la emite con la misma llave', async () => {
    build();
    // Registro de antes de los pasos (sin `estado`): se trata como completo.
    registros.push({
      _id: new Types.ObjectId(),
      idempotencyKey: 'k-2',
      reason: 'defectuoso',
      restock: 'inventory',
      refundMethod: 'cash',
      sedeId,
      refundTotal: 15_000,
      lines: [
        { productId: HAMB, qty: 1, refund: 10_000, refundTax: 741 },
        { productId: GAS, qty: 1, refund: 5_000, refundTax: 799 },
      ],
      save: vi.fn(),
    });
    const r: any = await service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-2' }), user);
    expect(puerto.emitirNota.mock.calls[0][0].origen).toBe(`devolucion:${String(r._id)}`);
    expect(stock.reverseSale).not.toHaveBeenCalled();
    expect(r.notaFiscal.estado).toBe('emitida');
  });

  describe('pasos de la devolución y reintento con la misma llave (D1)', () => {
    const conLlave = (k: string, extra: Record<string, unknown> = {}) => devolucion({ idempotencyKey: k, ...extra });

    it('si falla el stock, queda en curso con la nota; el reintento lo termina sin repetir la nota', async () => {
      build();
      stock.reverseSale.mockRejectedValueOnce(new Error('kárdex caído'));
      await expect(service.create(saleId.toString(), conLlave('k-s'), user)).rejects.toThrow('kárdex caído');
      const r = registros[0];
      expect(r.estado).toBe('en_curso');
      expect(r.carteraHecha).toBe(true);
      expect(r.notaFiscal.estado).toBe('emitida');
      expect(r.stockHecho).toBe(false);
      expect(caja.movement).not.toHaveBeenCalled();
      expect(ledger.postSaleReturn).not.toHaveBeenCalled();

      const otra: any = await service.create(saleId.toString(), conLlave('k-s'), user);
      expect(otra).toBe(r);
      expect(registros).toHaveLength(1);
      expect(puerto.emitirNota).toHaveBeenCalledTimes(1);
      expect(stock.reverseSale).toHaveBeenCalledTimes(2);
      expect(caja.movement).toHaveBeenCalledTimes(1);
      expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
      expect(r.estado).toBe('completa');
    });

    it('si falla la caja, el libro sigue; el reintento anota solo la caja', async () => {
      build();
      caja.movement.mockRejectedValueOnce(new Error('No hay una caja abierta en esta sede'));
      const r: any = await service.create(saleId.toString(), conLlave('k-c'), user);
      // Solo falta la caja (N6): queda a la vista como pendiente de caja.
      expect(r.estado).toBe('pendiente_caja');
      expect(r.stockHecho).toBe(true);
      expect(r.cajaHecha).toBe(false);
      expect(r.asientoHecho).toBe(true);

      await service.create(saleId.toString(), conLlave('k-c'), user);
      expect(stock.reverseSale).toHaveBeenCalledTimes(1);
      expect(caja.movement).toHaveBeenCalledTimes(2);
      expect(caja.movement.mock.calls[1][0].amount).toBe(15_000);
      expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
      expect(r.estado).toBe('completa');
    });

    it('si falla el libro, el reintento postea solo el asiento', async () => {
      build();
      ledger.postSaleReturn.mockRejectedValueOnce(new Error('libro caído'));
      await expect(service.create(saleId.toString(), conLlave('k-l'), user)).rejects.toThrow('libro caído');
      const r = registros[0];
      expect(r.stockHecho).toBe(true);
      expect(r.cajaHecha).toBe(true);
      expect(r.asientoHecho).toBe(false);

      await service.create(saleId.toString(), conLlave('k-l'), user);
      expect(stock.reverseSale).toHaveBeenCalledTimes(1);
      expect(caja.movement).toHaveBeenCalledTimes(1);
      expect(ledger.postSaleReturn).toHaveBeenCalledTimes(2);
      expect(r.estado).toBe('completa');
    });

    it('una devolución completa no se vuelve a mover en el reintento', async () => {
      build();
      await service.create(saleId.toString(), conLlave('k-ok'), user);
      await service.create(saleId.toString(), conLlave('k-ok'), user);
      expect(stock.reverseSale).toHaveBeenCalledTimes(1);
      expect(caja.movement).toHaveBeenCalledTimes(1);
      expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
    });

    it('fiado: si la cartera ya bajó por esta devolución, el reintento no la vuelve a bajar', async () => {
      build(venta({ payment: { method: 'credit' } }));
      const returnId = new Types.ObjectId();
      cxc = {
        _id: new Types.ObjectId(),
        amount: 25_000,
        paidAmount: 0,
        status: 'open',
        ajustes: [{ returnId: String(returnId), amount: 15_000 }],
      };
      const r: any = {
        _id: returnId,
        idempotencyKey: 'k-f',
        estado: 'en_curso',
        carteraHecha: false,
        stockHecho: false,
        cajaHecha: false,
        asientoHecho: false,
        reason: 'defectuoso',
        restock: 'inventory',
        refundMethod: 'cash',
        sedeId,
        refundTotal: 15_000,
        tipRefund: 0,
        lines: [
          { productId: HAMB, qty: 1, refund: 10_000, refundTax: 741 },
          { productId: GAS, qty: 1, refund: 5_000, refundTax: 799 },
        ],
        components: [],
        save: vi.fn(async () => undefined),
      };
      registros.push(r);
      await service.create(saleId.toString(), conLlave('k-f'), user);
      expect(receivables.findOneAndUpdate).not.toHaveBeenCalled();
      expect(cxc.amount).toBe(25_000);
      expect(r.abonoCartera).toBe(15_000);
      expect(caja.movement).not.toHaveBeenCalled();
      expect(ledger.postSaleReturn.mock.calls[0][0].toReceivable).toBe(15_000);
      expect(r.estado).toBe('completa');
    });
  });

  describe('turno de la devolución (N1)', () => {
    it('doble clic con la misma llave: stock y caja se mueven una sola vez y el segundo recibe 409', async () => {
      build();
      let soltar!: () => void;
      const enStock = new Promise<void>((ok) => {
        stock.reverseSale.mockImplementationOnce(
          () => new Promise<void>((fin) => {
            soltar = fin;
            ok();
          }),
        );
      });
      const primera = service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-n1' }), user);
      await enStock;
      await expect(
        service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-n1' }), user),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('se está procesando') });
      soltar();
      const r: any = await primera;
      expect(r.estado).toBe('completa');
      expect(stock.reverseSale).toHaveBeenCalledTimes(1);
      expect(caja.movement).toHaveBeenCalledTimes(1);
      expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
      expect(r.procesandoHasta).toBeNull();
    });

    it('suelta solo su propio turno: si venció y otra petición lo tomó, no se lo quita (N5)', async () => {
      build();
      expect(SaleReturnsService.TURNO_MS).toBe(5 * 60 * 1000);
      let soltar!: () => void;
      const enStock = new Promise<void>((ok) => {
        stock.reverseSale.mockImplementationOnce(
          () => new Promise<void>((fin) => {
            soltar = fin;
            ok();
          }),
        );
      });
      const primera = service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-n5' }), user);
      await enStock;
      // El turno de A venció y B lo tomó con su propio valor.
      const deB = new Date(Date.now() + 4 * 60_000);
      registros[0].procesandoHasta = deB;
      soltar();
      await primera;
      expect(registros[0].procesandoHasta).toBe(deB);
    });

    it('al fallar suelta el turno: el reintento entra enseguida', async () => {
      build();
      stock.reverseSale.mockRejectedValueOnce(new Error('kárdex caído'));
      await expect(service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-n1b' }), user)).rejects.toThrow();
      expect(registros[0].procesandoHasta).toBeNull();
      const r: any = await service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-n1b' }), user);
      expect(r.estado).toBe('completa');
    });

    it('un turno vencido (la petición murió) se puede retomar', async () => {
      build();
      ledger.postSaleReturn.mockRejectedValueOnce(new Error('libro caído'));
      await expect(service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-n1c' }), user)).rejects.toThrow();
      // Como si la petición hubiera muerto sin soltarlo, hace rato.
      registros[0].procesandoHasta = new Date(Date.now() - 1_000);
      const r: any = await service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-n1c' }), user);
      expect(r.estado).toBe('completa');
      expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    });
  });

  describe('devoluciones varadas (N2)', () => {
    /** Devolución sin llave que falló en el stock hace `minutos`. */
    async function varada(minutos: number) {
      stock.reverseSale.mockRejectedValueOnce(new Error('kárdex caído'));
      await expect(service.create(saleId.toString(), devolucion(), user)).rejects.toThrow();
      const r = registros[registros.length - 1];
      r.createdAt = new Date(Date.now() - minutos * 60_000);
      return r;
    }

    it('el barrido hace stock y libro pero NUNCA la caja: queda pendiente de caja (N6)', async () => {
      build();
      const vieja = await varada(30);
      expect(vieja.estado).toBe('en_curso');
      const res = await service.completarVaradas();
      expect(res).toEqual({ completadas: 0, pendientesCaja: 1, fallidas: 0, ocupadas: 0 });
      expect(vieja.estado).toBe('pendiente_caja');
      expect(vieja.stockHecho).toBe(true);
      expect(vieja.asientoHecho).toBe(true);
      expect(caja.movement).not.toHaveBeenCalled();
      expect(stock.reverseSale).toHaveBeenCalledTimes(2);
      // Lo hace como quien la registró, con acceso solo a su sede.
      expect(stock.reverseSale.mock.calls[1][2]).toMatchObject({ email: user.email, sedeIds: [sedeId.toString()] });
      // Un segundo barrido ya no la toma ni cuenta como error.
      expect(await service.completarVaradas()).toEqual({ completadas: 0, pendientesCaja: 0, fallidas: 0, ocupadas: 0 });

      // El cajero la completa a mano con su caja abierta.
      const hecha: any = await service.completarPendiente(String(vieja._id), user);
      expect(hecha.estado).toBe('completa');
      expect(caja.movement).toHaveBeenCalledTimes(1);
      expect(caja.movement.mock.calls[0][0]).toMatchObject({ type: 'out', amount: 15_000 });
      expect(stock.reverseSale).toHaveBeenCalledTimes(2);
      expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
    });

    it('una devolución sin efectivo que sacar sí queda completa con el barrido', async () => {
      build();
      stock.reverseSale.mockRejectedValueOnce(new Error('kárdex caído'));
      await expect(
        service.create(saleId.toString(), devolucion({ refundMethod: 'transfer' }), user),
      ).rejects.toThrow();
      registros[0].createdAt = new Date(Date.now() - 30 * 60_000);
      const res = await service.completarVaradas();
      expect(res.completadas).toBe(1);
      expect(caja.movement).not.toHaveBeenCalled();
    });

    it('completar a mano sin caja abierta: 409 claro y sigue pendiente de caja', async () => {
      build();
      const vieja = await varada(30);
      await service.completarVaradas();
      caja.movement.mockRejectedValueOnce(new NotFoundException('No hay una caja abierta en esta sede'));
      await expect(service.completarPendiente(String(vieja._id), user)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('No hay una caja abierta'),
      });
      expect(vieja.estado).toBe('pendiente_caja');
      expect(vieja.procesandoHasta).toBeNull();
    });

    it('no toca una reciente ni una con el turno vigente', async () => {
      build();
      const reciente = await varada(2);
      const otra = await varada(30);
      otra.procesandoHasta = new Date(Date.now() + 60_000);
      const res = await service.completarVaradas();
      expect(res.completadas).toBe(0);
      expect(reciente.estado).toBe('en_curso');
      expect(otra.estado).toBe('en_curso');
    });

    it('la que vuelve a fallar se cuenta y el barrido sigue', async () => {
      build();
      await varada(30);
      stock.reverseSale.mockRejectedValueOnce(new Error('sigue caído'));
      const res = await service.completarVaradas();
      expect(res).toEqual({ completadas: 0, pendientesCaja: 0, fallidas: 1, ocupadas: 0 });
    });

    it('POST /sales/returns/:id/completar la termina a mano', async () => {
      build();
      const r = await varada(1);
      const hecha: any = await service.completarPendiente(String(r._id), user);
      expect(hecha.estado).toBe('completa');
      expect(ledger.postSaleReturn).toHaveBeenCalledTimes(1);
      // Una completa se devuelve tal cual, sin mover nada.
      await service.completarPendiente(String(r._id), user);
      expect(stock.reverseSale).toHaveBeenCalledTimes(2);
    });

    it('completar a mano exige acceso a la sede y responde 404 si no existe', async () => {
      build();
      const r = await varada(1);
      const ajeno = { ...user, sedeIds: [new Types.ObjectId().toString()] } as unknown as JwtUser;
      await expect(service.completarPendiente(String(r._id), ajeno)).rejects.toMatchObject({ status: 403 });
      await expect(service.completarPendiente(new Types.ObjectId().toString(), user)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('reintento con otra carga (D2)', () => {
    it.each([
      ['otra cantidad', { lines: [{ productId: HAMB.toString(), qty: 2 }] }],
      ['otro medio', { refundMethod: 'transfer' }],
      ['otro destino', { restock: 'waste' }],
      ['otro motivo', { reason: 'otro' }],
    ])('%s con la misma llave: 409 y no se mueve nada', async (_n, extra) => {
      build();
      await service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-d2' }), user);
      await expect(
        service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-d2', ...extra }), user),
      ).rejects.toMatchObject({ status: 409 });
      expect(registros).toHaveLength(1);
      expect(stock.reverseSale).toHaveBeenCalledTimes(1);
    });

    it('la misma carga en otro orden de líneas es el mismo reintento', async () => {
      build();
      const r = await service.create(saleId.toString(), devolucion({ idempotencyKey: 'k-o' }), user);
      const otra = await service.create(
        saleId.toString(),
        devolucion({
          idempotencyKey: 'k-o',
          lines: [{ productId: GAS.toString(), qty: 1 }, { productId: HAMB.toString(), qty: 1 }],
        }),
        user,
      );
      expect(otra).toBe(r);
    });
  });

  describe('propina con descuento de documento (D3)', () => {
    // Venta de lista $46.000 con $6.000 de descuento global ya prorrateado en
    // las líneas (como `SalesService.create`): lo pagado por productos es
    // $40.000, y `total` lleva además $600 de INC de bolsas.
    const conDescuento = () =>
      venta({
        tip: 3_001,
        total: 40_600,
        discountTotal: 6_000,
        lines: [
          { productId: HAMB, sku: 'H1', name: 'Hamburguesa', qty: 3, unitPrice: 11_000, taxKind: 'inc', taxBase: 27_778, taxAmount: 2_222 },
          { productId: GAS, sku: 'G1', name: 'Gaseosa', qty: 2, unitPrice: 6_500, taxKind: 'iva', taxBase: 8_403, taxAmount: 1_597 },
        ],
      });

    it('devolver el 100 % de los productos devuelve la propina entera', async () => {
      build(conDescuento());
      const r: any = await service.create(
        saleId.toString(),
        devolucion({ lines: [{ productId: HAMB.toString(), qty: 3 }, { productId: GAS.toString(), qty: 2 }] }),
        user,
      );
      expect(r.refundTotal).toBe(40_000);
      expect(r.tipRefund).toBe(3_001);
    });

    it('en pedazos también: la suma de los pedazos es la propina entera', async () => {
      build(conDescuento());
      await service.create(saleId.toString(), devolucion({ lines: [{ productId: HAMB.toString(), qty: 1 }] }), user);
      await service.create(saleId.toString(), devolucion({ lines: [{ productId: GAS.toString(), qty: 1 }] }), user);
      await service.create(
        saleId.toString(),
        devolucion({ lines: [{ productId: HAMB.toString(), qty: 2 }, { productId: GAS.toString(), qty: 1 }] }),
        user,
      );
      expect(registros.reduce((t, x) => t + x.refundTotal, 0)).toBe(40_000);
      expect(registros.reduce((t, x) => t + x.tipRefund, 0)).toBe(3_001);
    });
  });

  describe('venta fiada', () => {
    const fiada = () => venta({ payment: { method: 'credit' } });

    it('baja la cartera en vez de sacar plata: sin salida de caja y el asiento contra la 1305', async () => {
      build(fiada());
      cxc = { _id: new Types.ObjectId(), amount: 40_000, paidAmount: 0, status: 'open' };
      const r: any = await service.create(saleId.toString(), devolucion(), user);
      expect(cxc.amount).toBe(25_000);
      expect(cxc.status).toBe('open');
      const upd = receivables.findOneAndUpdate.mock.calls[0][1];
      expect(upd.$push.ajustes).toMatchObject({ amount: 15_000, returnId: String(r._id) });
      expect(caja.movement).not.toHaveBeenCalled();
      expect(ledger.postSaleReturn.mock.calls[0][0].toReceivable).toBe(15_000);
      expect(r.abonoCartera).toBe(15_000);
    });

    it('con abonos: baja hasta el saldo y solo el resto sale en efectivo', async () => {
      build(fiada());
      cxc = { _id: new Types.ObjectId(), amount: 40_000, paidAmount: 30_000, status: 'partial' };
      await service.create(saleId.toString(), devolucion(), user);
      expect(cxc.amount).toBe(30_000);
      expect(cxc.status).toBe('paid');
      expect(caja.movement.mock.calls[0][0].amount).toBe(5_000);
      expect(ledger.postSaleReturn.mock.calls[0][0].toReceivable).toBe(10_000);
    });

    it('si la nota falla, la cartera vuelve a su valor y la devolución se retira', async () => {
      build(fiada());
      cxc = { _id: new Types.ObjectId(), amount: 40_000, paidAmount: 0, status: 'open' };
      receivables.findOneAndUpdate.mockImplementation((f: any, upd: any) => ({
        exec: async () => {
          cxc = { ...cxc, amount: cxc.amount + upd.$inc.amount };
          return cxc;
        },
      }));
      puerto.emitirNota.mockRejectedValue(new ConflictException('sin PIN'));
      await expect(service.create(saleId.toString(), devolucion(), user)).rejects.toBeInstanceOf(ConflictException);
      expect(cxc.amount).toBe(40_000);
      expect(registros).toHaveLength(0);
      expect(stock.reverseSale).not.toHaveBeenCalled();
    });

    it('fiado a un empleado (sin CxC): 409, la nómina no admite rebaja parcial', async () => {
      build(fiada());
      cxc = null;
      await expect(service.create(saleId.toString(), devolucion(), user)).rejects.toBeInstanceOf(ConflictException);
      expect(model.create).not.toHaveBeenCalled();
    });
  });
});
