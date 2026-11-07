import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
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

import { ContingenciaBarrido } from './contingencia.barrido';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/** Alerta diaria de contingencia (Fase 9): por empresa, frente al plazo de 48 h. */
describe('ContingenciaBarrido', () => {
  const ahora = new Date('2026-11-06T12:00:00Z');
  const h = (n: number) => new Date(ahora.getTime() - n * 3_600_000);
  const empresas = [
    { _id: new Types.ObjectId(), dbName: 'biz_a' },
    { _id: new Types.ObjectId(), dbName: 'biz_b' },
  ];
  const chain = (v: unknown): any => {
    const c: any = { select: () => c, sort: () => c, limit: () => c, lean: () => c, exec: async () => v };
    return c;
  };

  function build(docsPorDb: Record<string, unknown[]>, ventasPorDb: Record<string, { saleNumber: string; createdAt: Date }[]> = {}) {
    const vistos: string[] = [];
    const model: any = {
      find: vi.fn((filtro: any) => {
        const db = TenantContext.current()?.dbName ?? '';
        vistos.push(db);
        expect(filtro).toMatchObject({ 'contingencia.tipo': { $exists: true }, 'contingencia.cerradaAt': null });
        return chain(docsPorDb[db] ?? []);
      }),
    };
    const sales = {
      pendientesDeContingencia: vi.fn(async () => {
        const ventas = ventasPorDb[TenantContext.current()?.dbName ?? ''] ?? [];
        return { total: ventas.length, ventas };
      }),
    };
    const b = new ContingenciaBarrido(model, { listActive: vi.fn(async () => empresas) } as never, sales as never);
    return { b, vistos };
  }

  it('clasifica por plazo dentro del contexto de cada empresa y avisa sin poner el cron en rojo', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { b, vistos } = build(
      {
        biz_a: [
          { fullNumber: 'FE1', dianStatus: 'contingency', contingencia: { tipo: '04', declaradaAt: h(60) } },
          { fullNumber: 'EPOS2', dianStatus: 'contingency', contingencia: { tipo: '08', declaradaAt: h(40), restablecidoAt: h(30) } },
          { fullNumber: 'CONT3', dianStatus: 'draft', contingencia: { tipo: '07', declaradaAt: h(50), superadaAt: h(50) } },
          { fullNumber: 'CONT4', dianStatus: 'draft', contingencia: { tipo: '07', declaradaAt: h(1), superadaAt: h(1) } },
          { fullNumber: 'CONT5', dianStatus: 'rejected', contingencia: { tipo: '03', declaradaAt: h(2) } },
        ],
      },
      { biz_b: [{ saleNumber: 'FV-9', createdAt: h(47) }, { saleNumber: 'FV-10', createdAt: h(2) }] },
    );
    const r = await b.barrer({ ahora });
    expect(vistos).toEqual(['biz_a', 'biz_b']);
    expect(r.estado).toBe('ok');
    expect(r.cifras).toMatchObject({
      abiertas: 5,
      sinCorrer: 1,
      enPlazo: 1,
      porVencer: 1,
      vencidas: 1,
      rechazadas: 1,
      ventasSinTranscribir: 2,
      ventasPorVencer: 1,
      ventasVencidas: 0,
    });
    expect(r.detalle).toMatch(/alerta: 3 documento\(s\) o venta\(s\).*1 rechazado\(s\) en 2 empresa/);
    const mensajes = error.mock.calls.map((c) => String(c[0]));
    expect(mensajes.some((m) => m.includes('EPOS2') && m.includes('CONT3 (07, vencido)'))).toBe(true);
    expect(mensajes.some((m) => m.includes('RECHAZADOS') && m.includes('CONT5'))).toBe(true);
    expect(mensajes.some((m) => m.includes('FV-9'))).toBe(true);
    error.mockRestore();
  });

  it('sin nada abierto: ok sin detalle', async () => {
    const { b } = build({});
    const r = await b.barrer({ ahora });
    expect(r).toMatchObject({ estado: 'ok', cifras: { abiertas: 0 } });
    expect(r.detalle).toBeUndefined();
  });

  it('si una empresa falla, el barrido responde error y sigue', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { b } = build({});
    (b as any).sales.pendientesDeContingencia = vi.fn(async () => {
      if (TenantContext.current()?.dbName === 'biz_a') throw new Error('base caída');
      return { total: 0, ventas: [] };
    });
    const r = await b.barrer({ ahora });
    expect(r.estado).toBe('error');
    expect(r.cifras).toMatchObject({ fallidas: 1 });
  });
});
