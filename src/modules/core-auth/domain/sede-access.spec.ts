import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import {
  canViewAllSedes,
  allowedSedeIds,
  hasSedeAccess,
  assertSedeAccess,
  SedeScopeUser,
} from './sede-access';
import { PERMISSIONS } from './permissions';
import { ROLES } from './roles';

const owner: SedeScopeUser = {
  role: ROLES.OWNER,
  permissions: [],
  sedeIds: [],
};

const conViewAll: SedeScopeUser = {
  role: ROLES.ADMIN,
  permissions: [PERMISSIONS.SEDE_VIEW_ALL],
  sedeIds: ['s1'],
};

const normal: SedeScopeUser = {
  role: ROLES.CASHIER,
  permissions: [PERMISSIONS.POS_SELL],
  sedeIds: ['s1', 's2'],
};

describe('canViewAllSedes', () => {
  it('el dueño ve todas las sedes', () => {
    expect(canViewAllSedes(owner)).toBe(true);
  });

  it('quien tiene sede.view_all ve todas las sedes', () => {
    expect(canViewAllSedes(conViewAll)).toBe(true);
  });

  it('un usuario normal NO ve todas las sedes', () => {
    expect(canViewAllSedes(normal)).toBe(false);
  });
});

describe('allowedSedeIds', () => {
  it('null (sin filtro) para quien ve todas', () => {
    expect(allowedSedeIds(owner)).toBeNull();
    expect(allowedSedeIds(conViewAll)).toBeNull();
  });

  it('la lista de sus sedes para el usuario normal', () => {
    expect(allowedSedeIds(normal)).toEqual(['s1', 's2']);
  });
});

describe('hasSedeAccess', () => {
  it('el dueño accede a cualquier sede', () => {
    expect(hasSedeAccess(owner, 'cualquiera')).toBe(true);
  });

  it('el usuario normal solo accede a las de su sedeIds', () => {
    expect(hasSedeAccess(normal, 's1')).toBe(true);
    expect(hasSedeAccess(normal, 's9')).toBe(false);
  });
});

describe('assertSedeAccess', () => {
  it('no lanza si el usuario tiene acceso', () => {
    expect(() => assertSedeAccess(normal, 's2')).not.toThrow();
    expect(() => assertSedeAccess(owner, 'otra')).not.toThrow();
  });

  it('lanza ForbiddenException si el usuario no tiene acceso', () => {
    expect(() => assertSedeAccess(normal, 's9')).toThrow(ForbiddenException);
  });
});
