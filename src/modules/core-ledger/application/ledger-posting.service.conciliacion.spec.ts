import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';

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

import { LedgerPostingService } from './ledger-posting.service';
import { LedgerConciliacionService } from './ledger-conciliacion.service';
import type { PostEntryInput } from './ledger.service';

/**
 * Un asiento que no se pudo escribir o reversar no puede quedar solo en el log
 * (checklist 1.13): queda como pendiente de conciliación de la empresa, con el
 * origen, la operación y el error, para que alguien lo vea y el script de
 * reconstrucción lo resuelva. Y sigue sin tumbar la operación de negocio.
 */
describe('LedgerPostingService · pendientes de conciliación', () => {
  afterEach(() => vi.restoreAllMocks());

  const gasto = {
    expenseId: 'gasto-7',
    date: '2026-10-14',
    sedeId: '68b0f3c2a1d4e5f6a7b8c9d0',
    amount: 50_000,
    tax: 0,
    status: 'paid' as const,
    paymentMethod: 'cash',
    concept: 'Arriendo',
  };

  it('si el posteo falla, anota el pendiente «post» y no lanza', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockRejectedValue(new Error('Cuentas inexistentes: 5195')),
    };
    const conciliacion = { registrar: vi.fn().mockResolvedValue(undefined) };
    const service = new LedgerPostingService(ledger as never, conciliacion as never);

    await expect(service.postExpense(gasto)).resolves.toBeUndefined();

    expect(conciliacion.registrar).toHaveBeenCalledWith({
      sourceType: 'expense',
      sourceId: 'gasto-7',
      operacion: 'post',
      error: 'Cuentas inexistentes: 5195',
    });
  });

  it('si la reversa falla, anota el pendiente «reverse» con el error', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ledger = { reverseBySource: vi.fn().mockRejectedValue(new Error('mongo caído')) };
    const conciliacion = { registrar: vi.fn().mockResolvedValue(undefined) };
    const service = new LedgerPostingService(ledger as never, conciliacion as never);

    await service.reverseSale('venta-42', 'a@b.co');

    expect(conciliacion.registrar).toHaveBeenCalledWith({
      sourceType: 'sale',
      sourceId: 'venta-42',
      operacion: 'reverse',
      error: 'mongo caído',
    });
  });

  it('un posteo que sale bien no anota nada', async () => {
    const ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue({}),
    };
    const conciliacion = { registrar: vi.fn() };
    const service = new LedgerPostingService(ledger as never, conciliacion as never);

    await service.postExpense(gasto);
    expect(conciliacion.registrar).not.toHaveBeenCalled();
  });

  it('si anotar el pendiente también falla, la operación de negocio sigue', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const pendientes = {
      findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.reject(new Error('sin red')) })),
    };
    const conciliacion = new LedgerConciliacionService(pendientes as never);
    const ledger = {
      findBySource: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const service = new LedgerPostingService(ledger as never, conciliacion);

    await expect(service.postExpense(gasto)).resolves.toBeUndefined();
    const mensajes = error.mock.calls.map((c) => String(c[0]));
    expect(mensajes.some((m) => m.startsWith('CONCILIAR:') && m.includes('gasto-7'))).toBe(true);
  });

  it('el pendiente se acumula por (origen, operación): upsert sobre el abierto', async () => {
    const pendientes = {
      findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const conciliacion = new LedgerConciliacionService(pendientes as never);

    await conciliacion.registrar({
      sourceType: 'sale',
      sourceId: 'v-1',
      operacion: 'post',
      error: 'x',
    });

    const [filtro, update, opciones] = pendientes.findOneAndUpdate.mock.calls[0] as any[];
    expect(filtro).toEqual({ sourceType: 'sale', sourceId: 'v-1', operacion: 'post', resuelto: false });
    expect(update.$inc).toEqual({ intentos: 1 });
    expect(update.$set.error).toBe('x');
    expect(opciones).toMatchObject({ upsert: true });
  });

  it('lista todos los pendientes abiertos, página por página (no solo los primeros)', async () => {
    const todos = Array.from({ length: 1_203 }, (_, i) => ({
      _id: String(i).padStart(6, '0'),
      sourceType: 'sale',
      sourceId: `v${i}`,
    }));
    const pendientes = {
      find: vi.fn((filtro: any) => {
        const desde = filtro._id?.$gt ?? '';
        const cadena: any = {
          sort: () => cadena,
          limit: (n: number) => ({
            exec: async () => todos.filter((p) => p._id > desde).slice(0, n),
          }),
        };
        return cadena;
      }),
    };
    const conciliacion = new LedgerConciliacionService(pendientes as never);

    const lista = await conciliacion.todosLosAbiertos();

    expect(lista).toHaveLength(1_203);
    expect(pendientes.find).toHaveBeenCalledTimes(3);
    expect(pendientes.find.mock.calls[0]![0]).toEqual({ resuelto: false });
  });

  describe('gasto editado: reversa y reposteo', () => {
    /** Libro en memoria con la semántica del índice: un solo asiento vivo por origen. */
    function libroEnMemoria() {
      const asientos: (PostEntryInput & { _id: string; reversedBy?: string; reversalOf?: string })[] = [];
      const vivo = (t: string, id: string) =>
        asientos.find((a) => a.sourceType === t && a.sourceId === id && !a.reversalOf && !a.reversedBy) ??
        null;
      const ledger = {
        findBySource: vi.fn(async (t: string, id: string) => vivo(t, id)),
        post: vi.fn(async (input: PostEntryInput) => {
          const existente = vivo(input.sourceType, input.sourceId!);
          if (existente) return existente;
          const a = { ...input, _id: `as-${asientos.length + 1}` };
          asientos.push(a);
          return a;
        }),
        reverseBySource: vi.fn(async (t: string, id: string) => {
          const original = vivo(t, id);
          if (!original) return null;
          const contra = { ...original, _id: `as-${asientos.length + 1}`, sourceType: `reversal:${t}`, reversalOf: original._id };
          asientos.push(contra);
          original.reversedBy = contra._id;
          return contra;
        }),
      };
      return { asientos, ledger };
    }

    it('reversa el asiento viejo y postea el nuevo con el mismo origen', async () => {
      const { asientos, ledger } = libroEnMemoria();
      const service = new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never);

      await service.postExpense(gasto);
      await service.reverseExpense('gasto-7', 'a@b.co');
      await service.postExpense({ ...gasto, amount: 80_000 });

      expect(asientos).toHaveLength(3);
      const vivos = asientos.filter((a) => !a.reversalOf && !a.reversedBy);
      expect(vivos).toHaveLength(1);
      expect(vivos[0]!.lines.find((l) => l.debit)?.debit).toBe(80_000);
      expect(asientos[1]!.sourceType).toBe('reversal:expense');
    });
  });
});
