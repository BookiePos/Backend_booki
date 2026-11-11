import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { SaldoFavorService } from './saldo-favor.service';

/**
 * Saldo a favor por cliente (Fase 6C): abono y consumo idempotentes por
 * origen, consumo atómico contra el saldo, reverso al anular y reporte que
 * concilia saldo, auxiliar y mayor de la 2805.
 *
 * Las colecciones son dobles en memoria que respetan lo que Mongo garantiza:
 * cada `findOneAndUpdate` evalúa su filtro y escribe en un solo paso, y cede
 * el turno antes, para que dos llamadas a la vez se entrelacen de verdad.
 */
describe('SaldoFavorService', () => {
  const A = new Types.ObjectId();
  type Fila = { _id: Types.ObjectId; customerId: Types.ObjectId; saldo: number; customerName?: string; aplicados?: Types.ObjectId[] };
  let filas: Map<string, Fila>;
  let movs: any[];
  let libro: number;
  let svc: SaldoFavorService;
  let saldos: any;
  let movimientos: any;

  const turno = () => new Promise<void>((r) => setImmediate(r));
  const tiene = (fila: Fila, id: unknown) => (fila.aplicados ?? []).some((x) => String(x) === String(id));
  const cumple = (fila: Fila, f: any): boolean => {
    if (f.customerId && String(f.customerId) !== String(fila.customerId)) return false;
    if (f._id && String(f._id) !== String(fila._id)) return false;
    if (f.saldo?.$gte !== undefined && fila.saldo < f.saldo.$gte) return false;
    if (f['aplicados.0'] && !(fila.aplicados ?? []).length) return false;
    if (f.aplicados?.$ne !== undefined) return !tiene(fila, f.aplicados.$ne);
    if (f.aplicados !== undefined) return tiene(fila, f.aplicados);
    return true;
  };
  const escribir = (fila: Fila, u: any) => {
    if (u.$inc) fila.saldo += u.$inc.saldo;
    if (u.$set) Object.assign(fila, u.$set);
    if (u.$addToSet && !tiene(fila, u.$addToSet.aplicados)) fila.aplicados = [...(fila.aplicados ?? []), u.$addToSet.aplicados];
    if (u.$pull) {
      const fuera = (u.$pull.aplicados.$in ?? [u.$pull.aplicados]).map(String);
      fila.aplicados = (fila.aplicados ?? []).filter((x) => !fuera.includes(String(x)));
    }
  };
  const cadena = (fn: () => any): any => {
    const c: any = { sort: () => c, limit: () => c, select: () => c, exec: async () => fn() };
    return c;
  };

  beforeEach(() => {
    filas = new Map();
    movs = [];
    libro = 0;
    saldos = {
      findOne: vi.fn((f: any) => ({
        exec: async () => {
          const fila = filas.get(String(f.customerId));
          return fila && cumple(fila, f) ? fila : null;
        },
      })),
      findOneAndUpdate: vi.fn((f: any, u: any, o: any = {}) => ({
        exec: async () => {
          await turno();
          const k = String(f.customerId);
          let fila = filas.get(k);
          if (fila && !cumple(fila, f)) {
            // Como Mongo: el upsert que no casa intenta insertar y choca con el índice único.
            if (o.upsert) throw Object.assign(new Error('dup'), { code: 11000 });
            return null;
          }
          if (!fila) {
            if (!o.upsert) return null;
            filas.set(k, (fila = { _id: new Types.ObjectId(), customerId: f.customerId, saldo: 0 }));
          }
          escribir(fila, u);
          return fila;
        },
      })),
      updateOne: vi.fn((f: any, u: any) => ({
        exec: async () => {
          const fila = [...filas.values()].find((x) => cumple(x, f));
          if (fila) escribir(fila, u);
          return {};
        },
      })),
      find: vi.fn((f: any = {}) => cadena(() => [...filas.values()].filter((x) => cumple(x, f)))),
    };
    movimientos = {
      create: vi.fn(async (d: any) => {
        if (movs.some((m) => m.sourceType === d.sourceType && m.sourceId === d.sourceId && m.tipo === d.tipo)) {
          throw Object.assign(new Error('dup'), { code: 11000 });
        }
        const m = { ...d, _id: new Types.ObjectId(), createdAt: new Date() };
        movs.push(m);
        return m;
      }),
      deleteOne: vi.fn((f: any) => ({ exec: async () => void (movs = movs.filter((m) => String(m._id) !== String(f._id))) })),
      updateOne: vi.fn((f: any, u: any) => ({
        exec: async () => {
          await turno();
          const m = movs.find((x) => String(x._id) === String(f._id));
          if (m) Object.assign(m, u.$set);
          return {};
        },
      })),
      find: vi.fn((f: any) =>
        cadena(() =>
          movs.filter(
            (m) =>
              m.aplicado === f.aplicado &&
              (!f.customerId || m.customerId) &&
              (!f._id || f._id.$in.some((x: unknown) => String(x) === String(m._id))) &&
              (!f.createdAt || (m.createdAt ?? new Date(0)) < f.createdAt.$lt),
          ),
        ),
      ),
      findOne: vi.fn((f: any) => ({
        exec: async () => movs.find((m) => m.sourceType === f.sourceType && m.sourceId === f.sourceId && m.tipo === f.tipo) ?? null,
      })),
      aggregate: vi.fn(() => ({
        exec: async () => {
          const m = new Map<string, number>();
          for (const x of movs) {
            const k = x.customerId ? String(x.customerId) : '';
            m.set(k, (m.get(k) ?? 0) + (x.tipo === 'consumo' ? -x.amount : x.amount));
          }
          return [...m].map(([k, neto]) => ({ _id: k ? new Types.ObjectId(k) : null, neto }));
        },
      })),
    };
    const ledger: any = {
      trialBalance: vi.fn(async () => ({ rows: [{ code: '2805', debit: 0, credit: libro }] })),
    };
    svc = new SaldoFavorService(saldos, movimientos, ledger);
  });

  const abono = (amount: number, sourceId = 'r1', customerId: Types.ObjectId | null = A) =>
    svc.abonar({ customerId, amount, sourceType: 'sale_return', sourceId });
  const consumo = (amount: number, saleId: string) => svc.consumir({ customerId: A.toString(), amount, saleId });
  const saldo = () => svc.saldoDe(A.toString());
  /** El saldo cuadra peso por peso con el auxiliar. */
  const cuadra = async () => {
    const r = await svc.reporte();
    expect(r.filas.filter((f) => f.descuadre !== 0)).toEqual([]);
  };
  const envejecer = () => movs.forEach((m) => (m.createdAt = new Date(0)));
  const caida = () => ({ exec: async () => Promise.reject(new Error('base caída')) });

  it('abona una vez por origen', async () => {
    await abono(5_000);
    await abono(5_000);
    expect(await saldo()).toBe(5_000);
    expect(movs).toHaveLength(1);
  });

  it('consume de forma atómica: si no alcanza, 409 y no queda movimiento', async () => {
    await abono(5_000);
    await expect(consumo(6_000, 's1')).rejects.toBeInstanceOf(ConflictException);
    expect(movs.filter((m) => m.tipo === 'consumo')).toHaveLength(0);
    await consumo(3_000, 's1');
    // El reintento de la misma venta no gasta otra vez.
    await consumo(3_000, 's1');
    expect(await saldo()).toBe(2_000);
    await cuadra();
  });

  it('dos cobros a la vez no gastan el mismo peso', async () => {
    await abono(5_000);
    const r = await Promise.allSettled([consumo(4_000, 's1'), consumo(4_000, 's2')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await saldo()).toBe(1_000);
    await cuadra();
  });

  it('anular la venta devuelve lo gastado, una sola vez', async () => {
    await abono(5_000);
    await consumo(3_000, 's1');
    await svc.revertirConsumo('s1');
    await svc.revertirConsumo('s1');
    expect(await saldo()).toBe(5_000);
    // Una venta sin consumo no hace nada.
    await svc.revertirConsumo('otra');
    expect(movs).toHaveLength(3);
  });

  it('reporte: saldo por tercero, sin tercero y diferencia contra el mayor de la 2805', async () => {
    await abono(5_000);
    await abono(1_000, 'r2', null);
    await consumo(2_000, 's1');
    libro = 4_500;
    const r = await svc.reporte();
    expect(r.filas).toEqual([
      { customerId: A.toString(), customerName: undefined, saldo: 3_000, movimientos: 3_000, descuadre: 0 },
    ]);
    expect(r.totalClientes).toBe(3_000);
    expect(r.sinTercero).toBe(1_000);
    expect(r.libro2805).toBe(4_500);
    // $500 en la 2805 sin auxiliar: saldos de antes de la Fase 6C.
    expect(r.diferenciaLibro).toBe(500);
  });

  it('aplicar otra vez un movimiento ya aplicado no mueve nada', async () => {
    await abono(5_000);
    expect(movs[0].aplicado).toBe(true);
    await (svc as any).aplicar(movs[0]);
    await consumo(2_000, 's1');
    await (svc as any).aplicar(movs[1]);
    expect(await saldo()).toBe(3_000);
    await cuadra();
  });

  it('si la escritura del saldo falla, abonar y revertir retiran el movimiento (como consumir)', async () => {
    saldos.findOneAndUpdate.mockImplementationOnce(caida);
    await expect(abono(5_000)).rejects.toThrow('base caída');
    expect(movs).toHaveLength(0);
    await abono(5_000);
    await consumo(2_000, 's1');
    saldos.findOneAndUpdate.mockImplementationOnce(caida);
    await svc.revertirConsumo('s1');
    expect(movs.filter((m) => m.tipo === 'reverso')).toHaveLength(0);
    await svc.revertirConsumo('s1');
    expect(await saldo()).toBe(5_000);
    await cuadra();
  });

  it('el barrido aplica los movimientos que quedaron reservados sin efecto', async () => {
    // Un corte entre el auxiliar y el saldo: el abono quedó reservado, sin aplicar.
    movs.push({ _id: new Types.ObjectId(), customerId: A, tipo: 'abono', amount: 7_000, sourceType: 'sale_return', sourceId: 'r9', aplicado: false });
    const r = await svc.aplicarPendientes();
    expect(r).toEqual({ aplicados: 1, fallidos: 0 });
    expect(await saldo()).toBe(7_000);
    expect(await svc.aplicarPendientes()).toEqual({ aplicados: 0, fallidos: 0 });
  });

  describe('cortes y concurrencia (deuda de la 6C): el saldo se mueve y se marca en una sola escritura', () => {
    it('corte DESPUÉS de mover el saldo y antes de confirmar: el barrido confirma sin mover otra vez', async () => {
      movimientos.updateOne.mockImplementationOnce(caida);
      await abono(5_000);
      expect(await saldo()).toBe(5_000);
      expect(movs[0].aplicado).toBe(false);
      envejecer();
      expect(await svc.aplicarPendientes()).toEqual({ aplicados: 1, fallidos: 0 });
      expect(await saldo()).toBe(5_000);
      expect(movs[0].aplicado).toBe(true);
      await cuadra();
    });

    it('lo mismo con un consumo: no se cobra dos veces ni se da por «ya no alcanza»', async () => {
      await abono(5_000);
      movimientos.updateOne.mockImplementationOnce(caida);
      await consumo(5_000, 's1');
      expect(await saldo()).toBe(0);
      envejecer();
      // El saldo quedó en 0: si el barrido lo reintentara a ciegas, diría que no alcanza.
      expect(await svc.aplicarPendientes()).toEqual({ aplicados: 1, fallidos: 0 });
      expect(await saldo()).toBe(0);
      await cuadra();
    });

    it('la petición y el barrido a la vez sobre el mismo movimiento lo aplican una sola vez', async () => {
      movs.push({ _id: new Types.ObjectId(), customerId: A, tipo: 'abono', amount: 7_000, sourceType: 'sale_return', sourceId: 'r9', aplicado: false });
      await Promise.all([
        (svc as any).aplicar(movs[0]),
        (svc as any).aplicar(movs[0]),
        svc.aplicarPendientes(),
        abono(7_000, 'r9'),
      ]);
      expect(await saldo()).toBe(7_000);
      await cuadra();
    });

    it('el saldo se movió pero la respuesta se perdió: retirar el consumo devuelve el peso', async () => {
      await abono(5_000);
      const real = saldos.findOneAndUpdate.getMockImplementation();
      saldos.findOneAndUpdate.mockImplementationOnce((f: any, u: any, o: any) => ({
        exec: async () => {
          await real(f, u, o).exec();
          throw new Error('respuesta perdida');
        },
      }));
      await expect(consumo(3_000, 's1')).rejects.toThrow('respuesta perdida');
      expect(await saldo()).toBe(5_000);
      expect(movs.filter((m) => m.tipo === 'consumo')).toHaveLength(0);
      expect(filas.get(A.toString())!.aplicados).toHaveLength(1);
      await cuadra();
    });

    it('base caída del todo: el movimiento queda reservado y el reintento lo termina, una vez', async () => {
      const real = saldos.findOneAndUpdate.getMockImplementation();
      saldos.findOneAndUpdate.mockImplementation(caida);
      await expect(abono(5_000)).rejects.toThrow('base caída');
      // No se pudo comprobar si el saldo se movió: no se retira a ciegas.
      expect(movs).toHaveLength(1);
      expect(movs[0].aplicado).toBe(false);
      saldos.findOneAndUpdate.mockImplementation(real);
      await abono(5_000);
      await abono(5_000);
      expect(await saldo()).toBe(5_000);
      expect(movs).toHaveLength(1);
      expect(movs[0].aplicado).toBe(true);
      await cuadra();
    });

    it('el reintento de la operación termina un movimiento que quedó a medias, sin esperar al barrido', async () => {
      await abono(5_000);
      movs.push({ _id: new Types.ObjectId(), customerId: A, tipo: 'consumo', amount: 2_000, sourceType: 'sale', sourceId: 's1', aplicado: false, createdAt: new Date() });
      movs.push({ _id: new Types.ObjectId(), customerId: A, tipo: 'abono', amount: 1_000, sourceType: 'sale_return', sourceId: 'r2', aplicado: false, createdAt: new Date() });
      await consumo(2_000, 's1');
      await consumo(2_000, 's1');
      await abono(1_000, 'r2');
      await abono(1_000, 'r2');
      expect(await saldo()).toBe(4_000);
      expect(movs.every((m) => m.aplicado)).toBe(true);
      await cuadra();
    });

    it('dos primeros abonos a la vez del mismo cliente: el choque del upsert se repite y entran los dos', async () => {
      saldos.findOneAndUpdate.mockImplementationOnce(() => ({
        exec: async () => {
          // Otro abono crea la fila justo antes: este upsert choca con el índice único.
          await abono(2_000, 'r2');
          throw Object.assign(new Error('dup'), { code: 11000 });
        },
      }));
      await abono(3_000, 'r1');
      expect(await saldo()).toBe(5_000);
      await cuadra();
    });

    it('muchos movimientos a la vez: el saldo cuadra peso por peso con el auxiliar', async () => {
      await abono(10_000, 'base');
      const r = await Promise.allSettled([
        ...Array.from({ length: 15 }, (_, i) => abono(1_000 + i, `r${i}`)),
        ...Array.from({ length: 15 }, (_, i) => abono(1_000 + i, `r${i}`)),
        ...Array.from({ length: 12 }, (_, i) => consumo(3_000 + i, `s${i}`)),
        ...Array.from({ length: 12 }, (_, i) => consumo(3_000 + i, `s${i}`)),
        svc.aplicarPendientes(),
      ]);
      const abonado = 10_000 + Array.from({ length: 15 }, (_, i) => 1_000 + i).reduce((a, b) => a + b, 0);
      const gastado = movs.filter((m) => m.tipo === 'consumo').reduce((a, m) => a + m.amount, 0);
      expect(await saldo()).toBe(abonado - gastado);
      expect(await saldo()).toBeGreaterThanOrEqual(0);
      expect(movs.filter((m) => m.tipo === 'abono')).toHaveLength(16);
      expect(movs.every((m) => m.aplicado)).toBe(true);
      // Solo fallan consumos, y solo por saldo insuficiente.
      expect(r.filter((x) => x.status === 'rejected').every((x: any) => x.reason instanceof ConflictException)).toBe(true);
      await cuadra();
    });

    it('la poda quita solo las marcas confirmadas y viejas', async () => {
      await abono(5_000, 'viejo');
      await abono(1_000, 'reciente');
      movimientos.updateOne.mockImplementationOnce(caida);
      await abono(2_000, 'sin-confirmar');
      // Viejos el primero (confirmado) y el tercero (sin confirmar: su marca es lo que lo protege).
      movs[0].createdAt = new Date(Date.now() - SaldoFavorService.PODA_MS - 1_000);
      movs[2].createdAt = new Date(Date.now() - SaldoFavorService.PODA_MS - 1_000);
      expect(movs[2].aplicado).toBe(false);
      await (svc as any).podarMarcas();
      const marcas = () => filas.get(A.toString())!.aplicados!.map(String);
      expect(marcas()).toEqual([String(movs[1]._id), String(movs[2]._id)]);
      // El barrido confirma el que faltaba sin moverlo otra vez; lo ya podado no se vuelve a aplicar.
      expect(await svc.aplicarPendientes()).toEqual({ aplicados: 1, fallidos: 0 });
      expect(await saldo()).toBe(8_000);
      await cuadra();
    });
  });
});
