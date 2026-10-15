import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';

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

import { LedgerService } from './ledger.service';
import { ACC, SEED_ACCOUNTS } from '../domain/ledger.constants';

/**
 * Idempotencia del libro apoyada en el índice único (checklist 1.13).
 *
 * Antes la única defensa era «buscar y luego crear» en `safePost`: dos
 * requests a la vez (reintento del cliente, webhook duplicado) pasaban las dos
 * por la búsqueda y dejaban dos asientos de la misma venta. Ahora el índice
 * `origen_vivo_unico` rechaza el segundo con E11000 y `post` devuelve el que
 * ya existe, en lugar de fallar o duplicar.
 */
describe('LedgerService · un asiento vivo por origen', () => {
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let entries: any;
  let counters: any;
  let service: LedgerService;

  const e11000 = (keyPattern: Record<string, number>) =>
    Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern });

  beforeEach(() => {
    const accounts = {
      find: vi.fn(() => ({
        select: () => ({
          exec: () => Promise.resolve(SEED_ACCOUNTS.map((a) => ({ code: a.code }))),
        }),
        exec: () =>
          Promise.resolve(
            [ACC.CAJA, ACC.INGRESOS_VENTAS].map((code) => ({ code, name: `Cuenta ${code}` })),
          ),
      })),
    };
    entries = {
      estimatedDocumentCount: vi.fn(() => ({ exec: () => Promise.resolve(0) })),
      create: vi.fn((doc: unknown) => Promise.resolve(doc)),
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(null) })),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve({ modifiedCount: 1 }) })),
      aggregate: vi.fn(() => ({ exec: () => Promise.resolve([]) })),
    };
    // Contador atómico de consecutivos: cada $inc devuelve el siguiente.
    let seq = 0;
    counters = {
      findOneAndUpdate: vi.fn(() => ({ exec: () => Promise.resolve({ seq: ++seq }) })),
      create: vi.fn(() => Promise.resolve({})),
    };
    service = new LedgerService(accounts as never, entries as never, counters as never);
  });

  const venta = {
    date: '2026-10-14',
    sourceType: 'sale',
    sourceId: 'venta-1',
    memo: 'Venta FV-1',
    lines: [
      { accountCode: ACC.CAJA, debit: 10_000, sedeId: SEDE },
      { accountCode: ACC.INGRESOS_VENTAS, credit: 10_000, sedeId: SEDE },
    ],
  };

  it('si el índice rechaza el duplicado, devuelve el asiento vivo que ya existía', async () => {
    const existente = { _id: 'as-1', number: 'AS-000001', sourceType: 'sale', sourceId: 'venta-1' };
    entries.create.mockRejectedValueOnce(e11000({ sourceType: 1, sourceId: 1 }));
    entries.findOne.mockReturnValueOnce({ exec: () => Promise.resolve(existente) });

    await expect(service.post(venta)).resolves.toBe(existente);
    expect(entries.findOne).toHaveBeenCalledWith({
      sourceType: 'sale',
      sourceId: 'venta-1',
      reversalOf: null,
      reversedBy: null,
    });
  });

  describe('consecutivo', () => {
    it('sale de un contador atómico, no del conteo de documentos', async () => {
      const a: any = await service.post(venta);
      const b: any = await service.post({ ...venta, sourceId: 'venta-2' });
      expect([a.number, b.number]).toEqual(['AS-000001', 'AS-000002']);
      expect(counters.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'ledger:asiento' },
        { $inc: { seq: 1 } },
        { new: true },
      );
      expect(entries.estimatedDocumentCount).not.toHaveBeenCalled();
    });

    it('la primera vez arranca en el mayor consecutivo que ya existe', async () => {
      counters.findOneAndUpdate
        .mockReturnValueOnce({ exec: () => Promise.resolve(null) })
        .mockReturnValueOnce({ exec: () => Promise.resolve({ seq: 42 }) });
      entries.aggregate.mockReturnValueOnce({ exec: () => Promise.resolve([{ max: 41 }]) });

      const a: any = await service.post(venta);

      expect(counters.create).toHaveBeenCalledWith({ _id: 'ledger:asiento', seq: 41 });
      expect(a.number).toBe('AS-000042');
    });

    it('si el número ya está tomado (E11000 sobre number), reintenta con el siguiente', async () => {
      entries.create.mockRejectedValueOnce(e11000({ number: 1 }));

      const a: any = await service.post(venta);

      expect(a.number).toBe('AS-000002');
      expect(entries.create).toHaveBeenCalledTimes(2);
    });

    it('no reintenta para siempre: tras varios choques el error sube', async () => {
      entries.create.mockRejectedValue(e11000({ number: 1 }));
      await expect(service.post(venta)).rejects.toMatchObject({ code: 11000 });
      expect(entries.create.mock.calls.length).toBeLessThanOrEqual(5);
    });
  });

  it('busca el origen solo entre asientos vivos: uno reversado no cuenta como posteado', async () => {
    await service.findBySource('expense', 'g-1');
    expect(entries.findOne).toHaveBeenCalledWith({
      sourceType: 'expense',
      sourceId: 'g-1',
      reversalOf: null,
      reversedBy: null,
    });
  });

  describe('asientos manuales', () => {
    it('no pueden usar un origen del sistema (ocuparían el lugar del asiento real)', async () => {
      for (const sourceType of ['sale', 'expense', 'reversal:sale']) {
        await expect(
          service.postFromDto({ ...venta, sourceType } as never, 'a@b.co'),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(entries.create).not.toHaveBeenCalled();
    });

    it('una referencia repetida es un 409, no la devolución silenciosa del anterior', async () => {
      entries.create.mockRejectedValueOnce(e11000({ sourceType: 1, sourceId: 1 }));
      await expect(
        service.postFromDto(
          { ...venta, sourceType: 'ajuste', sourceId: 'FAC-9' } as never,
          'a@b.co',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reversa', () => {
    const original = () => ({
      _id: 'as-1',
      number: 'AS-000001',
      date: '2026-10-01',
      sourceType: 'sale',
      sourceId: 'venta-1',
      lines: [
        { accountCode: ACC.CAJA, accountName: 'Caja', debit: 10_000, credit: 0 },
        { accountCode: ACC.INGRESOS_VENTAS, accountName: 'Ingresos', debit: 0, credit: 10_000 },
      ],
      totalDebit: 10_000,
      totalCredit: 10_000,
      reversalOf: null,
      reversedBy: null,
      save: vi.fn(),
    });

    describe('fecha del contra-asiento', () => {
      // Hoy en Bogotá: 14-oct-2026 (02:00 UTC del 15 sigue siendo 14 allá).
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-15T02:00:00Z'));
      });
      afterEach(() => vi.useRealTimers());

      const reversar = async (date: string, fecha?: string) => {
        const doc = { ...original(), date };
        entries.findById.mockReturnValue({ exec: () => Promise.resolve(doc) });
        return service.reverse('as-1', 'a@b.co', fecha) as Promise<any>;
      };

      it('original del mismo mes: lleva la fecha del original (desaparece del mes)', async () => {
        const contra = await reversar('2026-10-03');
        expect(contra.date).toBe('2026-10-03');
      });

      it('original de un mes anterior: va hoy, y el memo deja número y fecha del original', async () => {
        // C. Co. art. 57 (orden cronológico) y E.T. art. 484: la anulación
        // se reconoce en el período en que ocurre; septiembre no se reabre.
        const contra = await reversar('2026-09-30');
        expect(contra.date).toBe('2026-10-14');
        expect(contra.memo).toContain('AS-000001');
        expect(contra.memo).toContain('2026-09-30');
      });

      it('acepta una fecha explícita entre la del original y hoy', async () => {
        const contra = await reversar('2026-09-30', '2026-10-01');
        expect(contra.date).toBe('2026-10-01');
      });

      it('rechaza una fecha anterior al original o futura', async () => {
        await expect(reversar('2026-09-30', '2026-09-29')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        await expect(reversar('2026-09-30', '2026-10-15')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        await expect(reversar('2026-09-30', '14/10/2026')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(entries.create).not.toHaveBeenCalled();
      });

      it('un original con fecha posterior a hoy se reversa en su propia fecha', async () => {
        const contra = await reversar('2026-11-02');
        expect(contra.date).toBe('2026-11-02');
      });
    });

    it('si el contra-asiento existe pero el original quedó sin puntero, lo repara', async () => {
      // Una reversa anterior creó el contra-asiento y falló al marcar el
      // original: sin reparar, el original seguiría «vivo» y el reposteo del
      // gasto editado se tomaría por ya hecho.
      const doc = original();
      entries.findOne
        .mockReturnValueOnce({ exec: () => Promise.resolve(doc) })
        .mockReturnValueOnce({ exec: () => Promise.resolve({ _id: 'as-2' }) });
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(doc) });
      entries.create.mockRejectedValueOnce(e11000({ reversalOf: 1 }));

      await expect(service.reverseBySource('sale', 'venta-1')).resolves.toBeNull();
      expect(entries.updateOne).toHaveBeenCalledWith(
        { _id: 'as-1', reversedBy: null },
        { $set: { reversedBy: 'as-2' } },
      );
    });

    it('si no puede reparar el puntero, falla (y queda pendiente de conciliar)', async () => {
      const doc = original();
      entries.findOne
        .mockReturnValueOnce({ exec: () => Promise.resolve(doc) })
        .mockReturnValueOnce({ exec: () => Promise.resolve({ _id: 'as-2' }) });
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(doc) });
      entries.create.mockRejectedValueOnce(e11000({ reversalOf: 1 }));
      entries.updateOne.mockReturnValueOnce({ exec: () => Promise.reject(new Error('sin red')) });

      await expect(service.reverseBySource('sale', 'venta-1')).rejects.toThrow('sin red');
    });

    it('si otra reversa ganó la carrera, responde «ya reversado» y no marca nada', async () => {
      const doc = original();
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(doc) });
      entries.create.mockRejectedValueOnce(e11000({ reversalOf: 1 }));
      entries.findOne.mockReturnValue({ exec: () => Promise.resolve({ _id: 'as-2' }) });

      await expect(service.reverse('as-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(doc.save).not.toHaveBeenCalled();
    });

    it('reverseBySource toma esa carrera como hecha (no es un fallo que conciliar)', async () => {
      const doc = original();
      entries.findOne
        .mockReturnValueOnce({ exec: () => Promise.resolve(doc) })
        .mockReturnValueOnce({ exec: () => Promise.resolve({ _id: 'as-2' }) });
      entries.findById.mockReturnValue({ exec: () => Promise.resolve(doc) });
      entries.create.mockRejectedValueOnce(e11000({ reversalOf: 1 }));

      await expect(service.reverseBySource('sale', 'venta-1')).resolves.toBeNull();
    });
  });
});
