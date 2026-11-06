import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

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
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const user = (permissions: string[]) => ({ permissions, sedeIds: ['s1'] }) as unknown as JwtUser;
const RANGO = {
  resolucion: '1876',
  prefijo: 'FE',
  desde: 1,
  hasta: 100,
  fechaResolucion: '2026-01-01',
  vigenciaDesde: '2026-01-02',
  vigenciaHasta: '2099-01-02',
  claveTecnica: 'CLAVE',
};

function montar(rango: unknown) {
  const einvoicing = { registerResolution: vi.fn(async () => []) };
  const rangosDian = { claveTecnicaDe: vi.fn(async () => rango) };
  const c = new (EinvoicingController as any)(einvoicing, {}, {}, {}, {}, {}, rangosDian, {}, {}, {});
  return { c: c as EinvoicingController, einvoicing, rangosDian };
}

describe('registerResolution con traerClaveDeDian', () => {
  it('rangos-dian exige einvoicing.configure', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, EinvoicingController.prototype.rangosDeLaDian)).toEqual([
      PERMISSIONS.EINVOICING_CONFIGURE,
    ]);
  });

  it('sin configure da 403 y no registra', async () => {
    const { c, einvoicing } = montar(RANGO);
    await expect(
      c.registerResolution('s1', { traerClaveDeDian: true } as never, user([PERMISSIONS.EINVOICING_ISSUE])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(einvoicing.registerResolution).not.toHaveBeenCalled();
  });

  it('sobrescribe número, prefijo, tramo y fechas con los de la DIAN', async () => {
    const { c, einvoicing } = montar(RANGO);
    await c.registerResolution(
      's1',
      {
        traerClaveDeDian: true,
        numero: '1876',
        prefijo: 'fe',
        rangoDesde: 1,
        rangoHasta: 100,
        vigenciaHasta: '2200-01-01',
        vigenciaDesde: '1990-01-01',
        fechaResolucion: '1990-01-01',
      } as never,
      user([PERMISSIONS.EINVOICING_CONFIGURE]),
    );
    const enviado = (einvoicing.registerResolution.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(enviado).toMatchObject({
      numero: '1876',
      prefijo: 'FE',
      vigenciaHasta: '2099-01-02',
      vigenciaDesde: '2026-01-02',
      fechaResolucion: '2026-01-01',
      claveTecnica: 'CLAVE',
    });
    expect(enviado).not.toHaveProperty('traerClaveDeDian');
  });

  it('si la DIAN no devuelve el rango, 400', async () => {
    const { c } = montar(undefined);
    await expect(
      c.registerResolution('s1', { traerClaveDeDian: true } as never, user([PERMISSIONS.EINVOICING_CONFIGURE])),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
