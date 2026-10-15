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

import { SedesController } from './sedes.controller';
import { ROLES } from '../../core-auth/domain/roles';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Editar una sede (nombre, dirección, resolución DIAN) exige tener acceso a
 * ella: un Gerente de la sede A con `sede.manage` no toca la sede B
 * (checklist 3.3).
 */
describe('SedesController · alcance por sede al editar', () => {
  const gerente = { role: ROLES.MANAGER, permissions: [], sedeIds: ['sA'] } as unknown as JwtUser;
  const dueno = { role: ROLES.OWNER, permissions: [], sedeIds: [] } as unknown as JwtUser;

  it('editar otra sede: 403 y no se toca', () => {
    const sedes = { update: vi.fn() };
    const ctrl = new SedesController(sedes as never);

    expect(() => ctrl.update('sB', {} as never, gerente)).toThrow(ForbiddenException);
    expect(sedes.update).not.toHaveBeenCalled();
  });

  it('editar la suya, o el dueño cualquiera: sí', () => {
    const sedes = { update: vi.fn() };
    const ctrl = new SedesController(sedes as never);

    ctrl.update('sA', {} as never, gerente);
    ctrl.update('sB', {} as never, dueno);
    expect(sedes.update).toHaveBeenCalledTimes(2);
  });
});
