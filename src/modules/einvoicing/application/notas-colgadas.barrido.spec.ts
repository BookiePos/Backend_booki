import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined, virtual: () => ({ get: () => undefined }) }) },
  };
});

import { NotasColgadasBarrido, NOTA_DRAFT_ALERTA_MIN_POR_DEFECTO } from './notas-colgadas.barrido';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/** Alerta de notas en draft colgadas (Fase 6C): por empresa, con su contexto. */
describe('NotasColgadasBarrido', () => {
  const ahora = new Date('2026-11-06T12:00:00Z');
  const empresas = [
    { _id: new Types.ObjectId(), dbName: 'biz_a' },
    { _id: new Types.ObjectId(), dbName: 'biz_b' },
  ];

  function build(porDb: Record<string, number>, minutos?: string) {
    const vistos: { db?: string; filtro: any }[] = [];
    const chain = (v: unknown): any => {
      const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => c, exec: async () => v };
      return c;
    };
    const model: any = {
      countDocuments: vi.fn((filtro: any) => {
        const db = TenantContext.current()?.dbName;
        vistos.push({ db, filtro });
        return chain(porDb[db ?? ''] ?? 0);
      }),
      find: vi.fn(() => chain([{ fullNumber: 'NC1' }, { fullNumber: 'NAC2' }])),
    };
    const b = new NotasColgadasBarrido(
      model,
      { listActive: vi.fn(async () => empresas) } as never,
      { get: () => minutos } as never,
    );
    return { b, model, vistos };
  }

  it('cuenta por empresa dentro de su contexto, con el límite de minutos, y avisa sin poner el cron en rojo', async () => {
    const { b, vistos } = build({ biz_a: 0, biz_b: 2 }, '30');
    const r = await b.barrer({ ahora });
    expect(vistos.map((v) => v.db)).toEqual(['biz_a', 'biz_b']);
    expect(vistos[0]!.filtro).toMatchObject({ type: { $in: ['credit_note', 'debit_note'] }, dianStatus: 'draft' });
    expect(vistos[0]!.filtro.createdAt.$lt).toEqual(new Date('2026-11-06T11:30:00Z'));
    expect(r.estado).toBe('ok');
    expect(r.detalle).toMatch(/2 nota\(s\) en draft hace más de 30 min en 1 empresa/);
    expect(r.cifras).toMatchObject({ colgadas: 2, empresasConColgadas: 1, minutos: 30 });
  });

  it('sin notas colgadas: ok sin detalle; minutos inválidos usan el valor por defecto', async () => {
    const { b } = build({}, 'abc');
    const r = await b.barrer({ ahora });
    expect(r).toMatchObject({ estado: 'ok', cifras: { colgadas: 0, minutos: NOTA_DRAFT_ALERTA_MIN_POR_DEFECTO } });
    expect(r.detalle).toBeUndefined();
  });

  it('si una empresa falla, el barrido lo dice como error y sigue con las demás', async () => {
    const { b, model } = build({ biz_b: 1 });
    model.countDocuments.mockImplementationOnce(() => ({ exec: async () => Promise.reject(new Error('base caída')) }));
    const r = await b.barrer({ ahora });
    expect(r.estado).toBe('error');
    expect(r.cifras).toMatchObject({ fallidas: 1, colgadas: 1 });
  });
});
