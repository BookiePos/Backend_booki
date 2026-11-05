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

const permiso = (h: unknown) => Reflect.getMetadata(PERMISSIONS_KEY, h as object);
const P = EinvoicingController.prototype;

describe('EinvoicingController · nómina por periodo y habilitación', () => {
  it.each(['prepararNomina', 'emitirNominaPeriodo', 'listarNomina', 'ajustarNomina'] as const)(
    '%s exige payroll.einvoice',
    (nombre) => {
      expect(permiso(P[nombre])).toEqual([PERMISSIONS.PAYROLL_EINVOICE]);
    },
  );

  it.each(['iniciarHabilitacionNomina', 'estadoHabilitacionNomina'] as const)('%s exige einvoicing.certificate', (nombre) => {
    expect(permiso(P[nombre])).toEqual([PERMISSIONS.EINVOICING_CERTIFICATE]);
  });
});
