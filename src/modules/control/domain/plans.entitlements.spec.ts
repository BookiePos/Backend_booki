import { describe, it, expect } from 'vitest';

import {
  PLAN_FEATURES,
  PLAN_QUOTAS,
  effectiveEntitlements,
  normalizePlan,
  planHasFeature,
} from './plans';

/**
 * Lo que una empresa recibe por lo que paga: funciones habilitadas y cupos.
 *
 * Es la frontera comercial del producto. Un error de más regala funciones que
 * nadie pagó; un error de menos le corta el acceso a un cliente al día, que es
 * peor todavía porque llama enojado y con razón.
 *
 * Los complementos (nómina, sedes y empleados adicionales) se compran encima
 * del plan, así que tienen que SUMAR sobre la base, nunca reemplazarla.
 */
describe('effectiveEntitlements', () => {
  describe('normalización del plan', () => {
    it('respeta un plan vigente', () => {
      expect(normalizePlan('punto')).toBe('punto');
      expect(normalizePlan('control')).toBe('control');
    });

    it('un plan desconocido abre en vez de cerrar', () => {
      // Decisión deliberada: ante un dato raro en la base no se deja sin
      // sistema a una empresa que sí paga. Se prefiere regalar de más.
      expect(normalizePlan('operacion')).toBe('cadena');
      expect(normalizePlan('inventado')).toBe('cadena');
      expect(normalizePlan(null)).toBe('cadena');
      expect(normalizePlan(undefined)).toBe('cadena');
    });
  });

  describe('sin complementos', () => {
    it('los cupos son exactamente los del plan', () => {
      const e = effectiveEntitlements('punto');

      expect(e.plan).toBe('punto');
      expect(e.quotas).toEqual(PLAN_QUOTAS.punto);
    });

    it('el plan de entrada no incluye nómina', () => {
      const e = effectiveEntitlements('punto');

      expect(planHasFeature(e, PLAN_FEATURES.PAYROLL)).toBe(false);
      expect(e.quotas.payrollEmployees).toBe(0);
    });

    it('los cupos crecen con el plan, nunca al revés', () => {
      const planes = ['punto', 'negocio', 'control', 'cadena'] as const;
      const documentos = planes.map(
        (p) => effectiveEntitlements(p).quotas.documentsPerMonth,
      );

      const ordenado = [...documentos].sort((a, b) => a - b);
      expect(documentos).toEqual(ordenado);
    });
  });

  describe('complemento de nómina', () => {
    it('habilita la función en un plan que no la trae', () => {
      const e = effectiveEntitlements('punto', { payroll: true });

      expect(planHasFeature(e, PLAN_FEATURES.PAYROLL)).toBe(true);
      expect(e.quotas.payrollEmployees).toBe(10);
    });

    it('no recorta el cupo de un plan que ya trae más empleados', () => {
      // Cadena cubre 25: contratar el complemento no puede bajarlo a 10.
      const base = PLAN_QUOTAS.cadena.payrollEmployees;
      const e = effectiveEntitlements('cadena', { payroll: true });

      expect(e.quotas.payrollEmployees).toBe(base);
    });
  });

  describe('complementos por cantidad', () => {
    it('los empleados adicionales suman al cupo del plan', () => {
      const base = PLAN_QUOTAS.control.payrollEmployees;
      const e = effectiveEntitlements('control', { extraEmployees: 5 });

      expect(e.quotas.payrollEmployees).toBe(base + 5);
    });

    it('las sedes adicionales suman al cupo del plan', () => {
      const base = PLAN_QUOTAS.cadena.sedes;
      const e = effectiveEntitlements('cadena', { extraSedes: 2 });

      expect(e.quotas.sedes).toBe(base + 2);
    });

    it('nómina y empleados adicionales se acumulan, no se pisan', () => {
      const e = effectiveEntitlements('punto', {
        payroll: true,
        extraEmployees: 3,
      });

      // 10 del complemento de nómina más 3 comprados aparte.
      expect(e.quotas.payrollEmployees).toBe(13);
    });

    it('una cantidad en cero o negativa no cambia nada', () => {
      const base = effectiveEntitlements('control').quotas;
      const e = effectiveEntitlements('control', {
        extraSedes: 0,
        extraEmployees: -5,
      });

      expect(e.quotas.sedes).toBe(base.sedes);
      expect(e.quotas.payrollEmployees).toBe(base.payrollEmployees);
    });
  });

  it('los complementos no tocan el cupo mensual de documentos', () => {
    // Los paquetes comprados se llevan como saldo aparte, precisamente porque
    // no expiran: inflar el cupo del mes los haría caducar cada 30 días.
    const base = PLAN_QUOTAS.control.documentsPerMonth;
    const e = effectiveEntitlements('control', {
      payroll: true,
      extraSedes: 3,
      extraEmployees: 10,
    });

    expect(e.quotas.documentsPerMonth).toBe(base);
  });

  it('no muta la tabla de cupos del plan entre llamadas', () => {
    // Los cupos se copian antes de sumarles complementos. Si se mutara la
    // tabla, el primer cliente con complementos se los regalaría a todos los
    // demás hasta el siguiente reinicio.
    effectiveEntitlements('control', { extraSedes: 7, extraEmployees: 7 });
    const limpio = effectiveEntitlements('control');

    expect(limpio.quotas).toEqual(PLAN_QUOTAS.control);
  });
});
