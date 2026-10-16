import { describe, expect, it } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../domain/permissions';

/**
 * Ítem 3.10: `@RequireAnyPermission` deja pasar con UNO de los permisos, sin
 * aflojar `@RequirePermissions` (siguen haciendo falta todos) ni el cierre por
 * omisión.
 */
class Rutas {
  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_MANAGE)
  todos(): void {}

  @RequireAnyPermission(PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_DEDUCTION_APPROVE)
  alguno(): void {}

  sinPolitica(): void {}
}

@RequireAnyPermission(PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_DEDUCTION_APPROVE)
class ClaseAlguno {
  // La del método manda: aquí hacen falta los dos.
  @RequirePermissions(PERMISSIONS.PAYROLL_VIEW, PERMISSIONS.PAYROLL_MANAGE)
  estricto(): void {}

  heredado(): void {}
}

function contexto(clase: new () => object, metodo: string, permissions: string[]) {
  return {
    getHandler: () => (clase.prototype as Record<string, unknown>)[metodo],
    getClass: () => clase,
    switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
  } as unknown as ExecutionContext;
}

const guard = new PermissionsGuard(new Reflector());
const pasa = (clase: new () => object, metodo: string, perms: string[]) =>
  guard.canActivate(contexto(clase, metodo, perms));

describe('PermissionsGuard · todos o alguno', () => {
  it('@RequirePermissions sigue exigiendo todos', () => {
    expect(pasa(Rutas, 'todos', ['payroll.view', 'payroll.manage'])).toBe(true);
    expect(() => pasa(Rutas, 'todos', ['payroll.view'])).toThrow(ForbiddenException);
  });

  it('@RequireAnyPermission pasa con cualquiera de los dos', () => {
    expect(pasa(Rutas, 'alguno', ['payroll.view'])).toBe(true);
    expect(pasa(Rutas, 'alguno', ['payroll.deduction.approve'])).toBe(true);
    expect(() => pasa(Rutas, 'alguno', ['pos.sell'])).toThrow(ForbiddenException);
    expect(() => pasa(Rutas, 'alguno', [])).toThrow(ForbiddenException);
  });

  it('sin política sigue cerrado', () => {
    expect(() => pasa(Rutas, 'sinPolitica', ['payroll.view'])).toThrow(
      'Endpoint sin permiso declarado',
    );
  });

  it('la política del método manda sobre la de la clase', () => {
    expect(() => pasa(ClaseAlguno, 'estricto', ['payroll.deduction.approve'])).toThrow(
      ForbiddenException,
    );
    expect(pasa(ClaseAlguno, 'heredado', ['payroll.deduction.approve'])).toBe(true);
  });
});
