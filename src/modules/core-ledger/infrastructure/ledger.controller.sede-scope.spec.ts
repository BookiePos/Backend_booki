import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

// Mismo patrón que el resto de specs: los decoradores de @nestjs/mongoose
// revientan al importar los esquemas que arrastra el servicio.
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

import { LedgerController } from './ledger.controller';
import { ROLES } from '../../core-auth/domain/roles';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Alcance por sede en el libro (checklist 3.3). El asiento no tiene sede
 * propia: la llevan sus renglones. Para un usuario limitado por sede, un
 * asiento es suyo solo si TODOS sus renglones caen en sedes suyas; uno con un
 * renglón de otra sede, o sin sede (nivel empresa: nómina, gastos generales…),
 * queda fuera de su alcance.
 */
describe('LedgerController · alcance por sede', () => {
  const S1 = '64b000000000000000000001';
  const S2 = '64b000000000000000000002';
  const AJENA = '64b000000000000000000009';

  const dueno = {
    role: ROLES.OWNER,
    permissions: [],
    sedeIds: [],
    email: 'd@x',
    userId: 'u0',
  } as JwtUser;
  const conViewAll = {
    role: ROLES.ADMIN,
    permissions: [PERMISSIONS.SEDE_VIEW_ALL],
    sedeIds: [],
    email: 'a@x',
    userId: 'u1',
  } as JwtUser;
  const gerente = (sedeIds: string[]) =>
    ({
      role: ROLES.MANAGER,
      permissions: [],
      sedeIds,
      email: 'g@x',
      userId: 'u2',
    }) as JwtUser;

  const asiento = (id: string, ...sedes: (string | undefined)[]) => ({
    _id: id,
    lines: sedes.map((s) => ({ accountCode: '1105', debit: 1, credit: 0, sedeId: s })),
  });

  const DE_S1 = asiento('e1', S1, S1);
  const DE_AJENA = asiento('e2', AJENA, AJENA);
  const MIXTO = asiento('e3', S1, AJENA);
  const EMPRESA = asiento('e4', undefined, undefined);
  const TODOS = [DE_S1, DE_AJENA, MIXTO, EMPRESA];

  let ledger: any;
  let ctrl: LedgerController;

  beforeEach(() => {
    ledger = {
      listEntries: vi.fn(async () => TODOS),
      getEntry: vi.fn(async (id: string) => TODOS.find((e) => e._id === id)),
      postFromDto: vi.fn(async () => ({ ok: true })),
      reverse: vi.fn(async () => ({ ok: true })),
      trialBalance: vi.fn(async (q: { sedeId?: string }) => {
        const monto = q.sedeId === S1 ? 10 : 7;
        return {
          rows: [{ code: '1105', debit: monto, credit: 0, balance: monto }],
          totalDebit: monto,
          totalCredit: 0,
          balanced: false,
        };
      }),
    };
    ctrl = new LedgerController(ledger as never, {} as never);
  });

  describe('listar asientos', () => {
    it('el dueño y sede.view_all ven todo, sin filtro', async () => {
      expect(await ctrl.listEntries(dueno)).toHaveLength(4);
      expect(await ctrl.listEntries(conViewAll)).toHaveLength(4);
    });

    it('el gerente pasa sus sedes al servicio: el filtro vive en Mongo, sin tope de 1000', async () => {
      ledger.listEntries.mockResolvedValue([DE_S1]);
      const r = await ctrl.listEntries(gerente([S1]));
      expect(r.map((e: any) => e._id)).toEqual(['e1']);
      const q = ledger.listEntries.mock.calls[0][0];
      expect(q.sedeIds).toEqual([S1]);
      expect(q.limit).toBeUndefined();
    });

    it('sede con asientos viejos detrás de muchos ajenos: el límite lo pone Mongo, no el controller', async () => {
      ledger.listEntries.mockResolvedValue([DE_S1]);
      const r = await ctrl.listEntries(
        gerente([S1]),
        undefined,
        undefined,
        undefined,
        undefined,
        '5',
      );
      expect(r).toHaveLength(1);
      expect(ledger.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ sedeIds: [S1], limit: 5 }),
      );
    });

    it('un usuario sin sedes recibe [] y nunca la empresa', async () => {
      ledger.listEntries.mockResolvedValue([]);
      expect(await ctrl.listEntries(gerente([]))).toEqual([]);
      const q = ledger.listEntries.mock.calls[0]?.[0];
      if (q) expect(q.sedeIds).toEqual([]);
    });

    it('limit no numérico, cero o negativo es 400 y no consulta', async () => {
      for (const malo of ['abc', '0', '-3', '1.5', '10x']) {
        await expect(
          ctrl.listEntries(dueno, undefined, undefined, undefined, undefined, malo),
        ).rejects.toThrow(BadRequestException);
      }
      expect(ledger.listEntries).not.toHaveBeenCalled();
    });

    it('limit válido llega al servicio', async () => {
      await ctrl.listEntries(dueno, undefined, undefined, undefined, undefined, '50');
      expect(ledger.listEntries).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });

  });

  describe('ver un asiento', () => {
    it('de su sede: sí', async () => {
      await expect(ctrl.getEntry('e1', gerente([S1]))).resolves.toBe(DE_S1);
    });

    it('de otra sede, mixto o de empresa: 403', async () => {
      const u = gerente([S1]);
      await expect(ctrl.getEntry('e2', u)).rejects.toThrow(ForbiddenException);
      await expect(ctrl.getEntry('e3', u)).rejects.toThrow(ForbiddenException);
      await expect(ctrl.getEntry('e4', u)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('registrar un asiento manual', () => {
    const dto = (...sedes: (string | undefined)[]) =>
      ({
        date: '2026-10-13',
        lines: sedes.map((s) => ({ accountCode: '1105', debit: 1, sedeId: s })),
      }) as never;

    it('en su sede: sí', async () => {
      await ctrl.postEntry(dto(S1, S1), gerente([S1]));
      expect(ledger.postFromDto).toHaveBeenCalled();
    });

    it('con un renglón en otra sede o sin sede: 403 y no se registra', async () => {
      const u = gerente([S1]);
      await expect(ctrl.postEntry(dto(S1, AJENA), u)).rejects.toThrow(ForbiddenException);
      await expect(ctrl.postEntry(dto(S1, undefined), u)).rejects.toThrow(ForbiddenException);
      expect(ledger.postFromDto).not.toHaveBeenCalled();
    });

    it('el dueño registra asientos de empresa (sin sede)', async () => {
      await ctrl.postEntry(dto(undefined, undefined), dueno);
      expect(ledger.postFromDto).toHaveBeenCalled();
    });
  });

  describe('reversar', () => {
    it('un asiento de otra sede: 403 y no se reversa', async () => {
      await expect(ctrl.reverse('e2', gerente([S1]))).rejects.toThrow(ForbiddenException);
      expect(ledger.reverse).not.toHaveBeenCalled();
    });

    it('uno de su sede: sí', async () => {
      await ctrl.reverse('e1', gerente([S1]));
      expect(ledger.reverse).toHaveBeenCalledWith('e1', 'g@x', undefined);
    });

    it('pasa la fecha opcional del contra-asiento al servicio', async () => {
      await ctrl.reverse('e1', dueno, { date: '2026-10-01' });
      expect(ledger.reverse).toHaveBeenCalledWith('e1', 'd@x', '2026-10-01');
    });
  });

  describe('balance de comprobación', () => {
    it('sede ajena: 403', async () => {
      await expect(
        ctrl.trialBalance(gerente([S1]), undefined, undefined, AJENA),
      ).rejects.toThrow(ForbiddenException);
      expect(ledger.trialBalance).not.toHaveBeenCalled();
    });

    it('sin sede, el gerente ve la suma de sus sedes y nunca la empresa', async () => {
      const r = await ctrl.trialBalance(gerente([S1, S2]));
      expect(ledger.trialBalance).toHaveBeenCalledTimes(2);
      for (const [q] of ledger.trialBalance.mock.calls) {
        expect(q.sedeId).toBeDefined();
      }
      expect(r.rows).toEqual([{ code: '1105', debit: 17, credit: 0, balance: 17 }]);
      expect(r.totalDebit).toBe(17);
    });

    it('marca el alcance: empresa para el dueño, sedes con su lista para el gerente', async () => {
      expect((await ctrl.trialBalance(dueno)).alcance).toBe('empresa');
      const r = await ctrl.trialBalance(gerente([S1, S2]));
      expect(r).toMatchObject({ alcance: 'sedes', sedes: [S1, S2] });
      const vacio = await ctrl.trialBalance(gerente([]));
      expect(vacio).toMatchObject({ alcance: 'sedes', sedes: [], rows: [] });
    });

    it('sedeId con formato inválido es 400 y no consulta', async () => {
      await expect(
        ctrl.trialBalance(dueno, undefined, undefined, 'zzz'),
      ).rejects.toThrow(BadRequestException);
      expect(ledger.trialBalance).not.toHaveBeenCalled();
    });

    it('el dueño sin sede ve la empresa entera', async () => {
      await ctrl.trialBalance(dueno);
      expect(ledger.trialBalance).toHaveBeenCalledWith({ from: undefined, to: undefined });
    });
  });
});
