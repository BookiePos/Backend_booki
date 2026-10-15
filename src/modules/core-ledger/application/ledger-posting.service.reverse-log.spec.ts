import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';

// Mismo patrón que el resto: los esquemas no se usan (ledger mockeado).
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

/**
 * La reversa contable es best-effort: si falla NO tumba la anulación (muchos
 * flujos dependen de eso). Pero el fallo deja un asiento vivo de una operación
 * anulada, así que se registra como ERROR con los ids, para conciliar.
 */
describe('LedgerPostingService · reversa fallida', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no lanza, pero deja un log de error con el origen para conciliar', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ledger = {
      reverseBySource: vi.fn().mockRejectedValue(new Error('mongo caído')),
    };
    const service = new LedgerPostingService(ledger as never, { registrar: vi.fn() } as never);

    await expect(service.reverseSale('venta-42', 'a@b.co')).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    const msg = String(error.mock.calls[0]?.[0]);
    expect(msg).toContain('sale');
    expect(msg).toContain('venta-42');
    expect(msg).toContain('mongo caído');
  });
});
