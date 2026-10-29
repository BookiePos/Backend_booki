import { describe, it, expect } from 'vitest';
import { computeResolutionStatus } from './resolution-status';

/**
 * El estado de la resolución es lo que decide si el negocio se entera con
 * tiempo o el día que ya no puede facturar. Una resolución se agota por dos
 * lados —números y días— y conseguir otra ante la DIAN no es inmediato.
 */
describe('computeResolutionStatus', () => {
  const hoy = new Date(2026, 7, 31); // 31 de agosto de 2026

  /** Resolución sana: rango amplio y un año por delante. */
  function sana() {
    return {
      numero: '18764096721256',
      prefijo: 'EN12',
      rangoDesde: 1,
      rangoHasta: 2000,
      vigenciaDesde: new Date(2026, 0, 1),
      vigenciaHasta: new Date(2027, 0, 1),
      claveTecnica: 'clave-dian',
    };
  }

  it('sin resolución avisa que no hay ninguna registrada', () => {
    const s = computeResolutionStatus(undefined, undefined, hoy);
    expect(s.estado).toBe('sin_configurar');
    expect(s.puedeEmitir).toBe(false);
  });

  it('con todo en orden deja emitir y cuenta lo que queda', () => {
    const s = computeResolutionStatus(sana(), 501, hoy);
    expect(s.estado).toBe('ok');
    expect(s.puedeEmitir).toBe(true);
    expect(s.consecutivo).toMatchObject({
      siguiente: 501,
      usados: 500,
      restantes: 1500,
      total: 2000,
    });
    expect(s.alertas).toHaveLength(0);
  });

  it('sin clave técnica no se puede emitir, aunque todo lo demás esté bien', () => {
    const s = computeResolutionStatus(
      { ...sana(), claveTecnica: undefined },
      1,
      hoy,
    );
    expect(s.estado).toBe('incompleta');
    expect(s.puedeEmitir).toBe(false);
    expect(s.alertas.join(' ')).toMatch(/clave técnica/i);
  });

  it('vencida: bloquea y lo dice con los días de retraso', () => {
    const s = computeResolutionStatus(
      { ...sana(), vigenciaHasta: new Date(2026, 7, 21) },
      501,
      hoy,
    );
    expect(s.estado).toBe('vencida');
    expect(s.puedeEmitir).toBe(false);
    expect(s.alertas[0]).toMatch(/venció hace 10 día/);
  });

  it('avisa ANTES de vencer, no el día del vencimiento', () => {
    const s = computeResolutionStatus(
      { ...sana(), vigenciaHasta: new Date(2026, 8, 15) },
      501,
      hoy,
    );
    expect(s.estado).toBe('por_vencer');
    // Sigue pudiendo facturar: es un aviso, no un bloqueo.
    expect(s.puedeEmitir).toBe(true);
    expect(s.alertas[0]).toMatch(/Vence en 15 día/);
  });

  it('avisa cuando queda poco rango, con margen para tramitar otra', () => {
    // 1.700 de 2.000 usados: 85 %.
    const s = computeResolutionStatus(sana(), 1701, hoy);
    expect(s.estado).toBe('rango_bajo');
    expect(s.puedeEmitir).toBe(true);
    expect(s.consecutivo.restantes).toBe(300);
  });

  it('rango agotado: no quedan números que emitir', () => {
    const s = computeResolutionStatus(sana(), 2001, hoy);
    expect(s.estado).toBe('rango_agotado');
    expect(s.puedeEmitir).toBe(false);
    expect(s.consecutivo.restantes).toBe(0);
  });

  it('una resolución que aún no empieza tampoco autoriza a facturar', () => {
    const s = computeResolutionStatus(
      { ...sana(), vigenciaDesde: new Date(2026, 9, 1) },
      1,
      hoy,
    );
    expect(s.estado).toBe('aun_no_vigente');
    expect(s.puedeEmitir).toBe(false);
  });

  it('vencer pesa más que quedarse sin números: se reporta lo que bloquea antes', () => {
    const s = computeResolutionStatus(
      { ...sana(), vigenciaHasta: new Date(2026, 7, 1) },
      2001,
      hoy,
    );
    expect(s.estado).toBe('vencida');
  });
});
