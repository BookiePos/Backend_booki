import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import {
  aplicarReclasificacion,
  contarReclasificacion,
  hoyColombia,
  leerCorte,
  renglonesDeReclasificacion,
  SOURCE_RECLASIFICACION,
} from './reclasificacion-impuestos-puc';
import type { PostEntryInput } from '../modules/core-ledger/application/ledger.service';

/**
 * Reclasificación 2367→2408 (IVA) y 2368→2495 (INC). Se prueba con un libro en
 * memoria: `aggregate` calcula el saldo de verdad a partir de los asientos, y
 * `post` agrega el asiento nuevo a ese libro. Así se ve que aplicar dos veces
 * deja lo mismo que aplicar una.
 */
describe('datos · reclasificación de IVA/INC al PUC', () => {
  const SEDE_A = '68b0f3c2a1d4e5f6a7b8c9d0';
  const SEDE_B = '68b0f3c2a1d4e5f6a7b8c9d1';
  const CORTE = '2026-10-31';

  type Line = { accountCode: string; debit?: number; credit?: number; sedeId?: string };
  type Entry = { date: string; sourceType: string; lines: Line[] };

  let libro: Entry[];
  let cuentas: { code: string; name: string; system: boolean }[];
  let post: ReturnType<typeof vi.fn>;

  /** Implementa lo justo del pipeline de `saldosAlCorte` sobre el libro. */
  function aggregate(pipeline: any[]) {
    const corte: string = pipeline[0].$match.date.$lte;
    const codes: string[] = pipeline[0].$match['lines.accountCode'].$in;
    const origenes: string[] = pipeline[0].$match.sourceType.$in;
    const grupos = new Map<string, any>();
    for (const e of libro.filter((x) => x.date <= corte && origenes.includes(x.sourceType))) {
      for (const l of e.lines.filter((x) => codes.includes(x.accountCode))) {
        const key = `${l.accountCode}|${l.sedeId ?? ''}`;
        const g = grupos.get(key) ?? {
          _id: { code: l.accountCode, sedeId: l.sedeId ?? null },
          debit: 0,
          credit: 0,
        };
        g.debit += l.debit ?? 0;
        g.credit += l.credit ?? 0;
        grupos.set(key, g);
      }
    }
    return { exec: () => Promise.resolve([...grupos.values()]) };
  }

  function deps() {
    return {
      entries: {
        aggregate: vi.fn(aggregate),
        findOne: vi.fn((f: any) => ({
          exec: () =>
            Promise.resolve(
              libro.find((e) => e.sourceType === f.sourceType && e.date > f.date.$gt) ??
                null,
            ),
        })),
      },
      accounts: {
        findOne: vi.fn((f: any) => ({
          exec: () => Promise.resolve(cuentas.find((c) => c.code === f.code) ?? null),
        })),
        updateOne: vi.fn((f: any, u: any) => ({
          exec: () => {
            const c = cuentas.find(
              (x) => x.code === f.code && x.system === f.system && x.name !== f.name.$ne,
            );
            if (c) c.name = u.$set.name;
            return Promise.resolve({});
          },
        })),
      },
      post,
    } as never;
  }

  beforeEach(() => {
    libro = [
      // Venta de retail en la sede A: IVA 1.900 a la 2367 (plan viejo).
      {
        date: '2026-10-05',
        sourceType: 'sale',
        lines: [
          { accountCode: '1105', debit: 11_900, sedeId: SEDE_A },
          { accountCode: '4135', credit: 10_000, sedeId: SEDE_A },
          { accountCode: '2367', credit: 1_900, sedeId: SEDE_A },
        ],
      },
      // Restaurante en la sede B: INC 2.222 a la 2368.
      {
        date: '2026-10-06',
        sourceType: 'sale',
        lines: [
          { accountCode: '1105', debit: 30_000, sedeId: SEDE_B },
          { accountCode: '4135', credit: 27_778, sedeId: SEDE_B },
          { accountCode: '2368', credit: 2_222, sedeId: SEDE_B },
        ],
      },
      // Devolución parcial en A: baja 400 de IVA.
      {
        date: '2026-10-07',
        sourceType: 'sale_return',
        lines: [
          { accountCode: '1105', credit: 2_500, sedeId: SEDE_A },
          { accountCode: '4135', debit: 2_100, sedeId: SEDE_A },
          { accountCode: '2367', debit: 400, sedeId: SEDE_A },
        ],
      },
      // Venta posterior al corte: no entra en esta reclasificación.
      {
        date: '2026-11-02',
        sourceType: 'sale',
        lines: [
          { accountCode: '1105', debit: 1_190, sedeId: SEDE_A },
          { accountCode: '4135', credit: 1_000, sedeId: SEDE_A },
          { accountCode: '2367', credit: 190, sedeId: SEDE_A },
        ],
      },
    ];
    cuentas = [
      { code: '2367', name: 'IVA por pagar', system: true },
      { code: '2368', name: 'INC por pagar', system: true },
    ];
    post = vi.fn((input: PostEntryInput) => {
      libro.push({ date: input.date, sourceType: input.sourceType, lines: input.lines });
      return Promise.resolve({});
    });
  });

  it('en seco cuenta el saldo pendiente sin escribir nada', async () => {
    const d: any = deps();
    const conteo = await contarReclasificacion(d, CORTE);

    expect(conteo).toEqual({ saldo2367: 1_500, saldo2368: 2_222, nombresViejos: 2 });
    expect(post).not.toHaveBeenCalled();
    expect(d.accounts.updateOne).not.toHaveBeenCalled();
  });

  it('postea un asiento cuadrado, por sede, a la fecha de corte', async () => {
    await aplicarReclasificacion(deps(), CORTE);

    expect(post).toHaveBeenCalledOnce();
    const asiento: PostEntryInput = post.mock.calls[0]![0];
    expect(asiento.date).toBe(CORTE);
    expect(asiento.sourceType).toBe(SOURCE_RECLASIFICACION);
    const debe = asiento.lines.reduce((a, l) => a + (l.debit ?? 0), 0);
    const haber = asiento.lines.reduce((a, l) => a + (l.credit ?? 0), 0);
    expect(debe).toBe(haber);
    expect(asiento.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '2367', debit: 1_500, sedeId: SEDE_A }),
        expect.objectContaining({ accountCode: '2408', credit: 1_500, sedeId: SEDE_A }),
        expect.objectContaining({ accountCode: '2368', debit: 2_222, sedeId: SEDE_B }),
        expect.objectContaining({ accountCode: '2495', credit: 2_222, sedeId: SEDE_B }),
      ]),
    );
  });

  it('deja el conteo en cero y renombra 2367/2368 a su nombre PUC', async () => {
    await aplicarReclasificacion(deps(), CORTE);

    expect(await contarReclasificacion(deps(), CORTE)).toEqual({
      saldo2367: 0,
      saldo2368: 0,
      nombresViejos: 0,
    });
    expect(cuentas.find((c) => c.code === '2367')?.name).toMatch(/ReteIVA/);
    expect(cuentas.find((c) => c.code === '2368')?.name).toMatch(/ReteICA/);
  });

  it('no traslada una ReteIVA real de un asiento manual (ni su reversa)', async () => {
    libro.push(
      {
        date: '2026-10-08',
        sourceType: 'manual',
        lines: [
          { accountCode: '2205', debit: 2_850, sedeId: SEDE_A },
          { accountCode: '2367', credit: 2_850, sedeId: SEDE_A },
        ],
      },
      {
        date: '2026-10-09',
        sourceType: 'reversal:manual',
        lines: [
          { accountCode: '2367', debit: 1_000, sedeId: SEDE_A },
          { accountCode: '2205', credit: 1_000, sedeId: SEDE_A },
        ],
      },
    );

    const conteo = await contarReclasificacion(deps(), CORTE);

    expect(conteo.saldo2367).toBe(1_500);
  });

  it('es idempotente: aplicar dos veces postea un solo asiento', async () => {
    await aplicarReclasificacion(deps(), CORTE);
    await aplicarReclasificacion(deps(), CORTE);

    expect(post).toHaveBeenCalledOnce();
  });

  it('un corte posterior traslada solo el residuo nuevo', async () => {
    await aplicarReclasificacion(deps(), CORTE);
    await aplicarReclasificacion(deps(), '2026-11-30');

    expect(post).toHaveBeenCalledTimes(2);
    const segundo: PostEntryInput = post.mock.calls[1]![0];
    expect(segundo.lines).toEqual([
      expect.objectContaining({ accountCode: '2367', debit: 190 }),
      expect.objectContaining({ accountCode: '2408', credit: 190 }),
    ]);
  });

  it('rechaza un corte anterior a una reclasificación ya hecha (la duplicaría)', async () => {
    await aplicarReclasificacion(deps(), CORTE);

    await expect(aplicarReclasificacion(deps(), '2026-10-15')).rejects.toThrow(
      /posterior al corte/,
    );
    expect(post).toHaveBeenCalledOnce();
  });

  it('un saldo deudor se traslada al revés', () => {
    const lines = renglonesDeReclasificacion([
      { accountCode: '2368', sedeId: null, debit: 500, credit: 200 },
    ]);

    expect(lines).toEqual([
      expect.objectContaining({ accountCode: '2368', credit: 300 }),
      expect.objectContaining({ accountCode: '2495', debit: 300 }),
    ]);
  });

  it('rechaza un corte posterior a hoy (fecha de Colombia)', () => {
    // Un corte futuro posteado hoy dejaría fuera lo que entre a 2367/2368 hasta
    // esa fecha y, al repetir con otro corte, el rechazo de cortes anteriores
    // bloquearía la corrección.
    expect(leerCorte(['--corte', '2026-10-14'], '2026-10-13')).toBeNull();
    expect(leerCorte(['--corte', '2026-10-13'], '2026-10-13')).toBe('2026-10-13');
  });

  it('toma la fecha de hoy en Colombia, no en UTC', () => {
    // 2026-10-14 03:00 UTC es todavía el 13 en Bogotá (UTC−5).
    expect(hoyColombia(new Date('2026-10-14T03:00:00Z'))).toBe('2026-10-13');
  });

  it('exige una fecha de corte válida', () => {
    expect(leerCorte(['--todas', '--corte', '2026-10-31'], '2026-12-31')).toBe('2026-10-31');
    expect(leerCorte(['--todas'])).toBeNull();
    expect(leerCorte(['--corte', '31/10/2026'])).toBeNull();
    expect(leerCorte(['--corte', '2026-02-31'])).toBeNull();
  });
});
