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

import { CierreAnualService } from './cierre-anual.service';
import { ORIGEN_CIERRE, ORIGEN_TRASLADO } from '../domain/cierre-anual';
import { ACC } from '../domain/ledger.constants';

/**
 * Cierre anual manual (R4, revisión 1.16). El servicio solo orquesta: se
 * prueba con un `LedgerService` falso. Hoy, en estas pruebas, es junio de 2026.
 */
describe('CierreAnualService', () => {
  const S1 = '64b0000000000000000000a1';
  let ledger: any;
  let service: CierreAnualService;
  /** Asientos vivos por `${sourceType}|${sourceId}`. */
  let vivos: Map<string, any>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T17:00:00Z'));
    vivos = new Map();
    ledger = {
      findBySource: vi.fn(async (t: string, id: string) => vivos.get(`${t}|${id}`) ?? null),
      anioCerrado: vi.fn(async (anio: number) => vivos.has(`${ORIGEN_CIERRE}|${anio}`)),
      saldosDeResultado: vi.fn(async (hasta: string) =>
        hasta === '2025-12-31'
          ? [
              { code: '4135', type: 'income', sedeId: S1, debit: 0, credit: 1_000 },
              { code: '5105', type: 'expense', sedeId: S1, debit: 400, credit: 0 },
            ]
          : [],
      ),
      post: vi.fn(async (input: any) => {
        const doc = { _id: `id-${input.sourceType}`, number: `AS-${input.sourceType}`, ...input };
        vivos.set(`${input.sourceType}|${input.sourceId}`, doc);
        return doc;
      }),
      reverse: vi.fn(async () => ({})),
      aniosConMovimiento: vi.fn(async () => [2024, 2025, 2026]),
      trialBalance: vi.fn(async () => ({ rows: [] })),
    };
    service = new CierreAnualService(ledger as never);
  });
  afterEach(() => vi.useRealTimers());

  it('cierra un año vencido: asiento al 31-dic y traslado al 1-ene', async () => {
    const r = await service.cerrar('2025', 'd@x.co');

    expect(r.resultado).toBe(600);
    const [cierre, traslado] = ledger.post.mock.calls.map((c: any[]) => c[0]);
    expect(cierre).toMatchObject({ date: '2025-12-31', sourceType: ORIGEN_CIERRE, sourceId: '2025' });
    expect(cierre.lines).toContainEqual({ accountCode: ACC.RESULTADO_EJERCICIO, credit: 600, sedeId: S1 });
    expect(traslado).toMatchObject({ date: '2026-01-01', sourceType: ORIGEN_TRASLADO, sourceId: '2025' });
    expect(traslado.lines).toContainEqual({ accountCode: ACC.RESULTADOS_ANTERIORES, credit: 600, sedeId: S1 });
  });

  it('no cierra el año en curso ni uno futuro', async () => {
    await expect(service.cerrar('2026', 'd@x.co')).rejects.toThrow(BadRequestException);
    await expect(service.cerrar('2027', 'd@x.co')).rejects.toThrow(/no ha terminado/);
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('exige cerrar en orden: un año anterior con resultados sin cerrar bloquea', async () => {
    ledger.saldosDeResultado.mockImplementation(async (hasta: string) =>
      hasta === '2024-12-31'
        ? [{ code: '4135', type: 'income', sedeId: S1, debit: 0, credit: 50 }]
        : [],
    );
    await expect(service.cerrar('2025', 'd@x.co')).rejects.toThrow(/cierra primero/);
    expect(ledger.post).not.toHaveBeenCalled();
  });

  it('un año sin ingresos ni gastos no se cierra', async () => {
    ledger.saldosDeResultado.mockResolvedValue([]);
    await expect(service.cerrar('2025', 'd@x.co')).rejects.toThrow(/no tiene ingresos/);
  });

  it('un año mal escrito es 400', async () => {
    await expect(service.cerrar('25', 'd@x.co')).rejects.toThrow(BadRequestException);
  });

  it('reintento: si el cierre quedó sin traslado, lo completa', async () => {
    vivos.set(`${ORIGEN_CIERRE}|2025`, {
      _id: 'c1',
      lines: [{ accountCode: ACC.RESULTADO_EJERCICIO, debit: 0, credit: 600, sedeId: S1 }],
    });
    const r = await service.cerrar('2025', 'd@x.co');

    expect(ledger.post).toHaveBeenCalledTimes(1);
    expect(ledger.post.mock.calls[0][0].sourceType).toBe(ORIGEN_TRASLADO);
    expect(r.traslado).not.toBeNull();
  });

  it('cerrar dos veces un año ya completo es 409', async () => {
    await service.cerrar('2025', 'd@x.co');
    await expect(service.cerrar('2025', 'd@x.co')).rejects.toThrow(ConflictException);
  });

  it('reabrir reversa primero el traslado y luego el cierre, cada uno con su fecha', async () => {
    await service.cerrar('2025', 'd@x.co');
    await service.reabrir('2025', 'd@x.co');

    expect(ledger.reverse.mock.calls).toEqual([
      [`id-${ORIGEN_TRASLADO}`, 'd@x.co', '2026-01-01', { reabriendoCierre: true }],
      [`id-${ORIGEN_CIERRE}`, 'd@x.co', '2025-12-31', { reabriendoCierre: true }],
    ]);
  });

  it('no reabre si el año siguiente está cerrado, ni un año abierto', async () => {
    vivos.set(`${ORIGEN_CIERRE}|2024`, { _id: 'c24', date: '2024-12-31', lines: [] });
    vivos.set(`${ORIGEN_CIERRE}|2025`, { _id: 'c25', date: '2025-12-31', lines: [] });
    await expect(service.reabrir('2024', 'd@x.co')).rejects.toThrow(/reábrelo primero/);
    await expect(service.reabrir('2023', 'd@x.co')).rejects.toThrow(/no está cerrado/);
    expect(ledger.reverse).not.toHaveBeenCalled();
  });

  it('estado: solo se puede cerrar el primer año vencido abierto', async () => {
    const e = await service.estado();
    expect(e.map((a) => [a.anio, a.cerrado, a.puedeCerrar])).toEqual([
      [2024, false, true],
      [2025, false, false],
      [2026, false, false],
    ]);
  });

  it('estado: año cerrado con traslado y saldo posterior; el resultado sale del balance sin el cierre', async () => {
    vivos.set(`${ORIGEN_CIERRE}|2024`, { number: 'AS-1', date: '2024-12-31', createdByEmail: 'd@x.co' });
    vivos.set(`${ORIGEN_TRASLADO}|2024`, { number: 'AS-2', date: '2025-01-01' });
    ledger.saldosDeResultado.mockImplementation(async (hasta: string) =>
      hasta === '2024-12-31'
        ? [
            { code: '4135', type: 'income', sedeId: S1, debit: 0, credit: 50 },
            { code: '5105', type: 'expense', sedeId: S1, debit: 50, credit: 0 },
          ]
        : [],
    );
    ledger.trialBalance.mockImplementation(async ({ from }: { from: string }) => ({
      rows:
        from === '2025-01-01'
          ? [
              { type: 'income', balance: 1_000 },
              { type: 'expense', balance: 400 },
              { type: 'asset', balance: 9_999 },
            ]
          : [],
    }));

    const e = await service.estado();

    expect(e[0]).toEqual({
      anio: 2024,
      cerrado: true,
      puedeCerrar: false,
      resultado: 0,
      cierre: { number: 'AS-1', date: '2024-12-31', createdByEmail: 'd@x.co', trasladoNumber: 'AS-2' },
      // +50 y −50 no se tapan: valores absolutos.
      saldoPosteriorAlCierre: 100,
    });
    expect(e[1]).toMatchObject({ anio: 2025, cerrado: false, puedeCerrar: true, resultado: 600, cierre: null });
    expect(e[2]).toMatchObject({ anio: 2026, puedeCerrar: false, saldoPosteriorAlCierre: 0 });
    // El traslado y el saldo posterior solo se leen del año cerrado.
    expect(ledger.findBySource.mock.calls.filter((c: any[]) => c[0] === ORIGEN_TRASLADO)).toEqual([
      [ORIGEN_TRASLADO, '2024'],
    ]);
    expect(ledger.saldosDeResultado.mock.calls).toEqual([['2024-12-31']]);
  });

  it('estado: los años se leen a la vez, no uno tras otro', async () => {
    let enCurso = 0;
    let maximo = 0;
    ledger.trialBalance.mockImplementation(async () => {
      enCurso += 1;
      maximo = Math.max(maximo, enCurso);
      await Promise.resolve();
      enCurso -= 1;
      return { rows: [] };
    });
    const e = await service.estado();
    expect(maximo).toBe(3);
    // El orden de salida sigue siendo el de los años.
    expect(e.map((a) => a.anio)).toEqual([2024, 2025, 2026]);
  });
});
