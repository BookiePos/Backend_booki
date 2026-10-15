import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

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

import { LedgerController } from './ledger.controller';
import { ROLES } from '../../core-auth/domain/roles';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { PERMISSIONS_KEY } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * GET /ledger/conciliacion: los asientos que el sistema no pudo escribir o
 * reversar (checklist 1.13). Lo ve quien ve finanzas de toda la empresa; un
 * pendiente no lleva sede, así que un usuario limitado por sede no lo ve.
 */
describe('LedgerController · pendientes de conciliación', () => {
  const dueno = { role: ROLES.OWNER, permissions: [], sedeIds: [], email: 'd@x', userId: 'u0' } as JwtUser;
  const gerente = {
    role: ROLES.MANAGER,
    permissions: [],
    sedeIds: ['64b000000000000000000001'],
    email: 'g@x',
    userId: 'u2',
  } as JwtUser;

  function ctrl() {
    const conciliacion = {
      contarAbiertos: vi.fn(async () => 2),
      listarAbiertos: vi.fn(async () => [{ sourceType: 'sale', sourceId: 'v1' }, { sourceType: 'expense', sourceId: 'g1' }]),
    };
    return { conciliacion, c: new LedgerController({} as never, conciliacion as never) };
  }

  it('devuelve el total abierto y la lista', async () => {
    const { c } = ctrl();
    const r = await c.pendientesDeConciliacion(dueno);
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(2);
  });

  it('un usuario limitado por sede recibe 403 y no consulta', async () => {
    const { c, conciliacion } = ctrl();
    await expect(c.pendientesDeConciliacion(gerente)).rejects.toBeInstanceOf(ForbiddenException);
    expect(conciliacion.listarAbiertos).not.toHaveBeenCalled();
  });

  it('declara finance.view (deny-by-default)', () => {
    const permisos = Reflect.getMetadata(
      PERMISSIONS_KEY,
      LedgerController.prototype.pendientesDeConciliacion,
    );
    expect(permisos).toEqual([PERMISSIONS.FINANCE_VIEW]);
  });
});
