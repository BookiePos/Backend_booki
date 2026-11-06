import { describe, expect, it } from 'vitest';
import {
  RESOLUCION_SETP,
  SET_FACTURA_EXIGIDO,
  esSetAceptadoDian,
  inicioSet,
  mensajeSetAceptado,
  planSet,
  reintentarRechazados,
  resumenSet,
} from './set-habilitacion-factura';

const T = new Date('2026-11-06T12:00:00Z');
const TS = '0a1b2c3d-1111-2222-3333-444455556666';

describe('set de habilitación de la factura', () => {
  it('el plan trae las facturas exigidas, con números únicos dentro del rango SETP', () => {
    const s = planSet('fe', TS, T);
    expect(s.documentos).toHaveLength(SET_FACTURA_EXIGIDO.fv + SET_FACTURA_EXIGIDO.nc + SET_FACTURA_EXIGIDO.nd);
    const nums = s.documentos.map((d) => d.numero);
    expect(new Set(nums).size).toBe(nums.length);
    for (const n of nums) {
      expect(n).toBeGreaterThan(RESOLUCION_SETP.desde);
      expect(n).toBeLessThan(RESOLUCION_SETP.hasta);
    }
    expect(s.siguiente).toBe(Math.max(...nums) + 1);
  });

  it('un set reiniciado más tarde no repite el primer número', () => {
    expect(inicioSet(T.getTime() + 60_000)).not.toBe(inicioSet(T.getTime()));
  });

  it('los rechazados vuelven con número nuevo y dejan constancia en el historial', () => {
    const s = planSet('fe', TS, T);
    s.documentos[0] = { ...s.documentos[0]!, estado: 'rechazado', mensaje: 'regla FAD06' };
    const r = reintentarRechazados(s);
    expect(r.documentos[0]!.estado).toBe('pendiente');
    expect(r.documentos[0]!.numero).toBe(s.siguiente);
    expect(r.historial).toHaveLength(1);
    expect(r.historial![0]!.mensaje).toBe('regla FAD06');
  });

  it('aprueba con todas las exigidas aceptadas o con el veredicto del set', () => {
    const s = planSet('fe', TS, T);
    expect(resumenSet(s).aprobada).toBe(false);
    const todas = { ...s, documentos: s.documentos.map((d) => ({ ...d, estado: 'aceptado' as const })) };
    expect(resumenSet(todas).aprobada).toBe(true);
    expect(resumenSet({ ...s, aceptadoPorDian: true }).aprobada).toBe(true);
  });

  it('el set del POS tiene su propio plan', () => {
    const s = planSet('pos', TS, T);
    expect(s.documentos.every((d) => d.tipo === 'pos')).toBe(true);
  });

  describe('veredicto «set aceptado» (casos de AlíaCorp S110/S111)', () => {
    it('lo afirma el mensaje de la DIAN', () => {
      expect(esSetAceptadoDian(`Set de prueba con identificador ${TS} se encuentra Aceptado.`, TS)).toBe(true);
      expect(mensajeSetAceptado(['x', `Set de prueba ${TS} se encuentra   Aceptado`], TS)).toMatch(/por aceptado/);
    });
    it('una negación no cuenta', () => {
      expect(esSetAceptadoDian('Set de prueba no se encuentra Aceptado', TS)).toBe(false);
    });
    it('el identificador de otro set no aprueba el propio', () => {
      expect(esSetAceptadoDian('Set de prueba con identificador 99999999-1111-2222-3333-444455556666 se encuentra Aceptado', TS)).toBe(false);
    });
    it('un texto cualquiera no cuenta', () => {
      expect(esSetAceptadoDian('Documento procesado correctamente', TS)).toBe(false);
      expect(esSetAceptadoDian(null, TS)).toBe(false);
    });
  });
});
