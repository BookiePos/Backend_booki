import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

// Patrón de `orders.service.checkout.spec.ts`: neutraliza los decoradores.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { EinvoicingService } from './einvoicing.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** `GET /einvoicing/resolutions` expone el corte guardado del talonario, solo en la de contingencia. */
describe('EinvoicingService · resolutionStatus', () => {
  const user = { email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;
  const hasta = new Date(Date.now() + 90 * 86_400_000);

  function montar(sede: Record<string, unknown>) {
    const counters = { findById: vi.fn(() => ({ exec: async () => null })) };
    const sedes = { list: vi.fn(async () => [{ id: 's1', code: 'S1', name: 'Sede', ...sede }]) };
    return new EinvoicingService({} as any, counters as any, {} as any, sedes as any, {} as any, {} as any);
  }

  it('la resolución de contingencia trae el corteTalonario guardado', async () => {
    const svc = montar({
      resolucionFe: { prefijo: 'FE', rangoDesde: 1, rangoHasta: 1000, vigenciaHasta: hasta },
      resolucionesFe: [
        { tipoDocumento: 'contingency', prefijo: 'CT', rangoDesde: 1, rangoHasta: 100, corteTalonario: 40, vigenciaHasta: hasta },
      ],
    });
    const [fila] = await svc.resolutionStatus(user);
    expect(fila!.otras[0]!.resolucion.corteTalonario).toBe(40);
    expect(fila!.resolucion).not.toHaveProperty('corteTalonario');
  });

  it('sin corte guardado el campo no aparece', async () => {
    const svc = montar({
      resolucionesFe: [{ tipoDocumento: 'contingency', prefijo: 'CT', rangoDesde: 1, rangoHasta: 100, vigenciaHasta: hasta }],
    });
    const [fila] = await svc.resolutionStatus(user);
    expect(fila!.otras[0]!.resolucion).not.toHaveProperty('corteTalonario');
  });
});

/** Notas por transmitir de los documentos de contingencia (alimenta `documentoFiscal.notasPendientes` de la venta). */
describe('EinvoicingService · notasPorTransmitirDeContingencia', () => {
  const doc1 = new Types.ObjectId();
  const doc2 = new Types.ObjectId();

  function montar(contingencia: Types.ObjectId[], notas: Types.ObjectId[]) {
    const consultas: any[] = [];
    const model = {
      find: vi.fn((f: any) => {
        consultas.push(f);
        const filas = f.type ? notas.map((referenceId) => ({ referenceId })) : contingencia.map((_id) => ({ _id }));
        const c: any = { select: () => c, lean: () => c, exec: async () => filas };
        return c;
      }),
    };
    return { svc: new EinvoicingService(model as any, {} as any, {} as any, {} as any, {} as any, {} as any), consultas };
  }

  it('solo salen los de contingencia, con sus notas sin aceptar', async () => {
    const { svc, consultas } = montar([doc1], [doc1, doc1]);
    const r = await svc.notasPorTransmitirDeContingencia([String(doc1), String(doc2), 'no-es-id']);
    expect(r).toEqual({ [String(doc1)]: 2 });
    expect(consultas[0]).toMatchObject({ 'contingencia.tipo': { $exists: true } });
    expect(consultas[1]).toMatchObject({ type: { $in: ['credit_note', 'debit_note'] }, dianStatus: { $ne: 'accepted' } });
  });

  it('un documento de contingencia sin notas da 0 y sin ids válidos no consulta', async () => {
    const { svc } = montar([doc1], []);
    expect(await svc.notasPorTransmitirDeContingencia([String(doc1)])).toEqual({ [String(doc1)]: 0 });
    const { svc: s2, consultas } = montar([], []);
    expect(await s2.notasPorTransmitirDeContingencia(['x'])).toEqual({});
    expect(consultas).toHaveLength(0);
  });
});
