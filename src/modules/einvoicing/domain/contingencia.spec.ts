import { describe, expect, it } from 'vitest';
import {
  admiteContingenciaDian,
  encabezadoContingencia,
  errorTalonario,
  estadoPlazo,
  sinRespuestaDian,
  tipoContingencia,
} from './contingencia';

const H = 3_600_000;

describe('contingencia · tipos', () => {
  it('factura 04/03 y POS 08/07; las notas y la nómina no tienen contingencia', () => {
    expect(tipoContingencia('invoice', 'dian')).toBe('04');
    expect(tipoContingencia('invoice', 'facturador')).toBe('03');
    expect(tipoContingencia('pos', 'dian')).toBe('08');
    expect(tipoContingencia('pos', 'facturador')).toBe('07');
    expect(tipoContingencia('credit_note', 'dian')).toBeNull();
    expect(tipoContingencia('payroll', 'facturador')).toBeNull();
  });

  it('encabezado: CustomizationID 20 solo en el POS; CUDE en la 03 y en el POS', () => {
    expect(encabezadoContingencia('04')).toEqual({ invoiceTypeCode: '04', customizationId: '10', esquemaCodigoUnico: 'CUFE-SHA384' });
    expect(encabezadoContingencia('03').esquemaCodigoUnico).toBe('CUDE-SHA384');
    expect(encabezadoContingencia('07').customizationId).toBe('20');
    expect(encabezadoContingencia('08').customizationId).toBe('20');
  });

  it('solo factura y POS de producción, y solo una vez, pasan a contingencia de la DIAN', () => {
    expect(admiteContingenciaDian({ type: 'pos', tipoAmbiente: '1' })).toBe(true);
    expect(admiteContingenciaDian({ type: 'invoice', tipoAmbiente: '2' })).toBe(false);
    expect(admiteContingenciaDian({ type: 'credit_note', tipoAmbiente: '1' })).toBe(false);
    expect(admiteContingenciaDian({ type: 'pos', tipoAmbiente: '1', contingencia: { tipo: '07' } })).toBe(false);
  });

  it('«sin respuesta» es RED del adaptador; nunca un veredicto ni un «ya procesado»', () => {
    expect(sinRespuestaDian({ codigo: 'RED', origen: 'adapter' })).toBe(true);
    expect(sinRespuestaDian({ codigo: 'YA_PROCESADO_DIAN', origen: 'dian' })).toBe(false);
    expect(sinRespuestaDian({ codigo: '99', origen: 'dian' })).toBe(false);
  });
});

describe('contingencia · plazo de 48 h', () => {
  const ahora = new Date('2026-11-06T12:00:00Z');
  it('04/08: no corre mientras la DIAN siga caída', () => {
    expect(estadoPlazo({ tipo: '04', declaradaAt: new Date(ahora.getTime() - 100 * H) }, ahora).fase).toBe('sin_correr');
  });
  it('04/08: corre desde que la DIAN volvió', () => {
    const e = estadoPlazo({ tipo: '08', declaradaAt: new Date(0), restablecidoAt: new Date(ahora.getTime() - 10 * H) }, ahora);
    expect(e.fase).toBe('en_plazo');
    expect(e.horasRestantes).toBe(38);
  });
  it('03/07: corre desde que se superó la falla; por vencer a menos de 24 h y vencido después de 48', () => {
    expect(estadoPlazo({ tipo: '07', declaradaAt: ahora, superadaAt: new Date(ahora.getTime() - 30 * H) }, ahora).fase).toBe('por_vencer');
    const v = estadoPlazo({ tipo: '03', declaradaAt: new Date(ahora.getTime() - 50 * H) }, ahora);
    expect(v.fase).toBe('vencido');
    expect(v.horasRestantes).toBe(-2);
  });
});

describe('contingencia · talonario', () => {
  const reso = { prefijo: 'CONT', rangoDesde: 1, rangoHasta: 100, vigenciaDesde: new Date('2026-01-01T00:00:00Z'), vigenciaHasta: new Date('2026-12-31T00:00:00Z') };
  it('acepta un número del rango con fecha vigente y no futura', () => {
    expect(errorTalonario({ numero: 7, fecha: '2026-11-04', hoy: '2026-11-06' }, reso)).toBeNull();
  });
  it('rechaza fuera de rango, fuera de vigencia, futuro o mal formado', () => {
    expect(errorTalonario({ numero: 101, fecha: '2026-11-04', hoy: '2026-11-06' }, reso)).toMatch(/no está en la numeración/);
    expect(errorTalonario({ numero: 7, fecha: '2025-11-04', hoy: '2026-11-06' }, reso)).toMatch(/fuera de la vigencia/);
    expect(errorTalonario({ numero: 7, fecha: '2026-11-07', hoy: '2026-11-06' }, reso)).toMatch(/posterior/);
    expect(errorTalonario({ numero: 7, fecha: '04/11/2026', hoy: '2026-11-06' }, reso)).toMatch(/AAAA-MM-DD/);
    expect(errorTalonario({ numero: 0, fecha: '2026-11-04', hoy: '2026-11-06' }, reso)).toMatch(/entero positivo/);
  });
});
