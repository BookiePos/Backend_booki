import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  canViewAllSedes,
  allowedSedeIds,
  hasSedeAccess,
  assertSedeAccess,
  resolveSedeScope,
  alcanceDeSedes,
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

describe('resolveSedeScope', () => {
  const A = '64b000000000000000000001';
  const B = '64b000000000000000000002';
  const AJENA = '64b000000000000000000009';
  const user: SedeScopeUser = { role: ROLES.CASHIER, permissions: [], sedeIds: [A, B] };

  it('si pide una sede suya, el alcance es solo esa', () => {
    expect(resolveSedeScope(user, B)).toEqual([B]);
  });

  it('si pide una sede ajena, 403', () => {
    expect(() => resolveSedeScope(user, AJENA)).toThrow(ForbiddenException);
  });

  it('si no pide sede, el alcance son sus sedes', () => {
    expect(resolveSedeScope(user)).toEqual([A, B]);
  });

  it('quien ve todas: sin filtro si no pide, o la sede que pida', () => {
    expect(resolveSedeScope(owner)).toBeNull();
    expect(resolveSedeScope(conViewAll, AJENA)).toEqual([AJENA]);
  });

  it('un sedeId con formato inválido es 400, también para quien ve todas', () => {
    expect(() => resolveSedeScope(user, 'no-es-un-id')).toThrow(BadRequestException);
    expect(() => resolveSedeScope(owner, 'sede1')).toThrow(BadRequestException);
  });

  it('sedeIds: [] sin sede pedida no ve nada; pidiendo una, 403', () => {
    const sinSedes: SedeScopeUser = { role: ROLES.CASHIER, permissions: [], sedeIds: [] };
    expect(resolveSedeScope(sinSedes)).toEqual([]);
    expect(() => resolveSedeScope(sinSedes, A)).toThrow(ForbiddenException);
  });
});

describe('alcanceDeSedes', () => {
  it('null es la empresa completa', () => {
    expect(alcanceDeSedes(null)).toEqual({ alcance: 'empresa' });
  });

  it('una lista, aun vacía, es alcance por sedes', () => {
    expect(alcanceDeSedes(['x'])).toEqual({ alcance: 'sedes', sedes: ['x'] });
    expect(alcanceDeSedes([])).toEqual({ alcance: 'sedes', sedes: [] });
  });
});
