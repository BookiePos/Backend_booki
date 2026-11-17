import { describe, expect, it } from 'vitest';
import {
  avisosPagoPrestacion,
  diasCubiertos,
  motivoCruceConLiquidacion,
  motivoEmpleadoSinPrestacion,
  motivoPagoPrestacionInvalido,
  type PagoPrestacionEntrada,
} from './pago-prestacion';

const HOY = '2027-03-01';
const prima = (o: Partial<PagoPrestacionEntrada> = {}): PagoPrestacionEntrada => ({
  tipo: 'prima',
  monto: 750_000,
  periodoDesde: '2026-07-01',
  periodoHasta: '2026-12-31',
  medioPago: '47',
  fechaPago: '2026-12-15',
  ...o,
});
const cesantias = (o: Partial<PagoPrestacionEntrada> = {}): PagoPrestacionEntrada =>
  prima({ tipo: 'cesantias', monto: 1_500_000, periodoDesde: '2026-01-01', periodoHasta: '2026-12-31', medioPago: '42', fechaPago: '2027-02-12', ...o });
const motivo = (p: PagoPrestacionEntrada) => motivoPagoPrestacionInvalido(p, HOY);

describe('diasCubiertos', () => {
  it('un semestre son 180 y un año 360 (método comercial, ambos extremos)', () => {
    expect(diasCubiertos('2026-01-01', '2026-06-30')).toBe(180);
    expect(diasCubiertos('2026-07-01', '2026-12-31')).toBe(180);
    expect(diasCubiertos('2026-01-01', '2026-12-31')).toBe(360);
    expect(diasCubiertos('2026-03-16', '2026-06-30')).toBe(105);
  });
});

describe('motivoPagoPrestacionInvalido', () => {
  it('acepta la prima del semestre, la consignación y los intereses', () => {
    expect(motivo(prima())).toBeNull();
    expect(motivo(prima({ retencionFuente: 10_000 }))).toBeNull();
    expect(motivo(cesantias({ destino: 'fondo' }))).toBeNull();
    expect(motivo(cesantias({ tipo: 'intereses_cesantias', monto: 180_000, fechaPago: '2027-01-30' }))).toBeNull();
  });

  it('tipo, monto y fechas', () => {
    expect(motivo(prima({ tipo: 'bono' }))).toMatch(/tipo/);
    expect(motivo(prima({ monto: 0 }))).toMatch(/entero de pesos mayor que cero/);
    expect(motivo(prima({ monto: 10.5 }))).toMatch(/entero de pesos/);
    expect(motivo(prima({ periodoDesde: '2026-02-30' }))).toMatch(/fechas válidas/);
    expect(motivo(prima({ periodoDesde: '2026-12-31', periodoHasta: '2026-07-01' }))).toMatch(/termina antes/);
    expect(motivo(prima({ medioPago: '99' }))).toMatch(/medio de pago/);
    expect(motivo(prima({ fechaPago: '2027-03-02' }))).toMatch(/futura/);
    expect(motivo(prima({ fechaPago: '2026-06-30' }))).toMatch(/anterior al periodo/);
  });

  it('la prima no cruza semestres ni las cesantías cruzan años', () => {
    expect(motivo(prima({ periodoDesde: '2026-01-01' }))).toMatch(/art\. 306 CST/);
    expect(motivo(prima({ periodoDesde: '2025-07-01' }))).toMatch(/art\. 306 CST/);
    expect(motivo(cesantias({ periodoDesde: '2025-06-01' }))).toMatch(/un solo año/);
  });

  it('retención: solo la prima, y siempre menor que lo pagado', () => {
    expect(motivo(cesantias({ retencionFuente: 1 }))).toMatch(/no llevan retención/);
    expect(motivo(prima({ retencionFuente: 750_000 }))).toMatch(/igualar ni superar/);
    expect(motivo(prima({ retencionFuente: -1 }))).toMatch(/no negativo/);
    expect(motivo(prima({ retencionFuente: 0.5 }))).toMatch(/entero/);
  });

  it('el destino solo aplica a las cesantías', () => {
    expect(motivo(prima({ destino: 'fondo' }))).toMatch(/solo aplica a las cesantías/);
    expect(motivo(cesantias({ destino: 'banco' }))).toMatch(/fondo o trabajador/);
  });
});

describe('motivoEmpleadoSinPrestacion', () => {
  const p = { tipo: 'prima' as const, periodoHasta: '2026-12-31' };
  it('contratista, aprendiz e integral no causan prestaciones', () => {
    expect(motivoEmpleadoSinPrestacion({ contractType: 'indefinido' }, p)).toBeNull();
    expect(motivoEmpleadoSinPrestacion({ contractType: 'prestacion_servicios' }, p)).toMatch(/no es una relación laboral/);
    expect(motivoEmpleadoSinPrestacion({ contractType: 'aprendizaje' }, p)).toMatch(/Ley 789/);
    expect(motivoEmpleadoSinPrestacion({ salaryType: 'integral' }, p)).toMatch(/art\. 132 CST/);
  });
  it('el tramo no termina antes del ingreso', () => {
    expect(motivoEmpleadoSinPrestacion({ hireDate: '2027-01-15' }, p)).toMatch(/antes de su ingreso/);
    expect(motivoEmpleadoSinPrestacion({ hireDate: '2026-09-01' }, p)).toBeNull();
  });
});

describe('motivoCruceConLiquidacion', () => {
  it('la liquidación ya paga las cesantías del año del retiro y la prima de su semestre', () => {
    expect(motivoCruceConLiquidacion({ tipo: 'cesantias', periodoHasta: '2026-12-31' }, '2027-02-20')).toBeNull();
    expect(motivoCruceConLiquidacion({ tipo: 'cesantias', periodoHasta: '2027-01-31' }, '2027-02-20')).toMatch(/2027-01-01/);
    expect(motivoCruceConLiquidacion({ tipo: 'prima', periodoHasta: '2026-06-30' }, '2026-10-20')).toBeNull();
    expect(motivoCruceConLiquidacion({ tipo: 'prima', periodoHasta: '2026-07-31' }, '2026-10-20')).toMatch(/2026-07-01/);
    expect(motivoCruceConLiquidacion({ tipo: 'prima', periodoHasta: '2026-12-31' }, undefined)).toBeNull();
  });
});

describe('avisosPagoPrestacion', () => {
  it('a tiempo: solo el recordatorio de la retención de la prima', () => {
    expect(avisosPagoPrestacion(prima())).toHaveLength(1);
    expect(avisosPagoPrestacion(prima())[0]).toMatch(/art\. 385 ET/);
    expect(avisosPagoPrestacion(cesantias({ destino: 'fondo' }))).toEqual([]);
    expect(avisosPagoPrestacion(cesantias({ tipo: 'intereses_cesantias', fechaPago: '2027-01-31' }))).toEqual([]);
  });
  it('fuera de plazo avisa con la norma (no bloquea)', () => {
    expect(avisosPagoPrestacion(prima({ fechaPago: '2026-12-21' })).join()).toMatch(/2026-12-20.*art\. 306 CST/);
    expect(avisosPagoPrestacion(prima({ periodoDesde: '2026-01-01', periodoHasta: '2026-06-30', fechaPago: '2026-07-01' })).join()).toMatch(/2026-06-30/);
    expect(avisosPagoPrestacion(cesantias({ destino: 'fondo', fechaPago: '2027-02-15' })).join()).toMatch(/2027-02-14.*Ley 50\/1990/);
    expect(avisosPagoPrestacion(cesantias({ tipo: 'intereses_cesantias', fechaPago: '2027-02-01' })).join()).toMatch(/2027-01-31.*Ley 52\/1975/);
  });
  it('cesantías entregadas al trabajador: art. 254 CST', () => {
    expect(avisosPagoPrestacion(cesantias({ destino: 'trabajador' })).join()).toMatch(/art\. 254 CST/);
  });
  it('un pago muy anterior al fin del tramo se avisa', () => {
    expect(avisosPagoPrestacion(prima({ fechaPago: '2026-09-01' })).join()).toMatch(/más de 45 días anterior/);
  });
});
