import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';

// Mismo patrón que el resto: los esquemas no se usan (modelos mockeados).
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

import { TreasuryPostingService } from './treasury-posting.service';

/**
 * Quitar el movimiento auto de tesorería es best-effort (no tumba la anulación),
 * pero si falla queda plata "entrada" al banco por una venta anulada: se
 * registra como ERROR con el origen, para conciliar.
 */
describe('TreasuryPostingService.reverse · fallo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no lanza, pero deja un log de error con el origen para conciliar', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const movements = {
      deleteMany: vi.fn(() => ({ exec: () => Promise.reject(new Error('timeout')) })),
    };
    const service = new TreasuryPostingService({} as never, movements as never);

    await expect(service.reverse('sale', 'venta-42')).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    const msg = String(error.mock.calls[0]?.[0]);
    expect(msg).toContain('sale:venta-42');
    expect(msg).toContain('timeout');
  });
});
