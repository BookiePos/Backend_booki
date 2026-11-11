import { describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { EinvoicingController } from './einvoicing.controller';
import { PERMISSIONS_KEY } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

const meta = (clave: string) => Reflect.getMetadata(clave, EinvoicingController.prototype.regenerarEntrega);

describe('POST /einvoicing/documentos/:id/entrega', () => {
  it('sigue pidiendo einvoicing.issue', () => {
    expect(meta(PERMISSIONS_KEY)).toEqual([PERMISSIONS.EINVOICING_ISSUE]);
  });

  it('tiene tope propio: 10 por minuto, más estricto que el global de 100', () => {
    expect(meta('THROTTLER:LIMITdefault')).toBe(10);
    expect(meta('THROTTLER:TTLdefault')).toBe(60_000);
  });

  it('el tope se cuenta por empresa, no por IP', async () => {
    const tracker = meta('THROTTLER:TRACKERdefault') as (req: Record<string, unknown>) => string;
    const clave = await TenantContext.run({ businessId: 'b1', dbName: 'biz_b1' }, async () =>
      tracker({ ip: '1.2.3.4' }),
    );
    expect(clave).toBe('biz:b1');
  });

  it('los demás endpoints de documentos no cambian de tope', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', EinvoicingController.prototype.transmitir)).toBeUndefined();
  });
});
