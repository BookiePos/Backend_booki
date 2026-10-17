import { describe, it, expect, vi } from 'vitest';

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

import { TraceabilityService } from './traceability.service';

/**
 * Ítem 4.11: el código de lote se busca como texto literal. Sin escapar,
 * `(a+)+$` llegaba a Mongo como regex con backtracking catastrófico, en el
 * clúster que comparten todas las empresas.
 */
describe('TraceabilityService.findLots · búsqueda literal', () => {
  function build() {
    const find = vi.fn(() => ({
      sort: () => ({ limit: () => ({ exec: () => Promise.resolve([]) }) }),
    }));
    const service = new TraceabilityService(
      { find } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, find };
  }
  const dueno = { role: 'owner', permissions: [], sedeIds: [] } as never;

  it('escapa los metacaracteres y acota el largo', async () => {
    const { service, find } = build();
    await service.findLots('(a+)+$' + 'x'.repeat(200), dueno);
    const { $regex } = (find.mock.calls[0] as any)[0].lotCode;
    expect($regex.startsWith('\\(a\\+\\)\\+\\$')).toBe(true);
    expect(new RegExp($regex).test('(a+)+$' + 'x'.repeat(200))).toBe(true);
    expect($regex.length).toBeLessThan(80);
  });

  it('un código normal sigue encontrando por coincidencia parcial', async () => {
    const { service, find } = build();
    await service.findLots(' L-2409 ', dueno);
    expect((find.mock.calls[0] as any)[0].lotCode).toEqual({
      $regex: 'L-2409',
      $options: 'i',
    });
  });
});
