import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { SalesController } from './sales.controller';

/** El reporte de saldos a favor es de toda la empresa (Fase 6C). */
describe('SalesController · reporte de saldos a favor', () => {
  const reporte = vi.fn(async () => ({ filas: [] }));
  const ctl = new SalesController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { reporte } as never, {} as never);

  it('quien ve todas las sedes lo recibe', async () => {
    const user = { role: 'owner', sedeIds: [], permissions: [] } as never;
    await expect(ctl.saldosFavor(user)).resolves.toEqual({ filas: [] });
  });

  it('quien está limitado por sede recibe 403', () => {
    const user = { role: 'cashier', sedeIds: ['s1'], permissions: [] } as never;
    expect(() => ctl.saldosFavor(user)).toThrow(ForbiddenException);
  });
});
