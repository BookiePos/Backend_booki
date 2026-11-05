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

import { EinvoicingController } from './einvoicing.controller';
import { PERMISSIONS_KEY } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';

/** El PIN de nómina es un secreto: solo quien puede cargar el certificado. */
describe('EinvoicingController.configurarNomina · permisos', () => {
  it('PUT sedes/:sedeId/emisor/nomina exige einvoicing.certificate', () => {
    const handler = EinvoicingController.prototype.configurarNomina;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      PERMISSIONS.EINVOICING_CERTIFICATE,
    ]);
  });
});
