import { describe, expect, it } from 'vitest';
import { motivoDeMensaje, motivosLegibles, resumenEstado } from './motivos-rechazo';

describe('motivoDeMensaje', () => {
  it('separa la regla de la DIAN del texto y añade la sugerencia conocida', () => {
    const m = motivoDeMensaje('Regla: FAJ43b, Rechazo: Nombre no corresponde al RUT');
    expect(m?.regla).toBe('FAJ43b');
    expect(m?.texto).toBe('Nombre no corresponde al RUT');
    expect(m?.sugerencia).toMatch(/RUT/);
  });
  it('un mensaje sin regla se muestra tal cual, sin inventar causa', () => {
    expect(motivoDeMensaje('algo raro')).toEqual({ texto: 'algo raro' });
  });
  it('vacío da null y recorta lo larguísimo', () => {
    expect(motivoDeMensaje('   ')).toBeNull();
    expect(motivoDeMensaje('x'.repeat(2000))!.texto.length).toBe(400);
  });
});

describe('motivosLegibles', () => {
  it('un aceptado no tiene motivos', () => {
    expect(motivosLegibles({ dianStatus: 'accepted', rechazoMotivo: 'viejo' })).toEqual([]);
  });
  it('usa los mensajes de la última respuesta y sin duplicados', () => {
    const r = motivosLegibles({
      dianStatus: 'rejected',
      respuestaDian: { codigo: 'X', mensajes: ['Regla: FAU04, Rechazo: totales', 'Regla: FAU04, Rechazo: totales'] },
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.regla).toBe('FAU04');
  });
  it('sin mensajes cae al rechazoMotivo guardado', () => {
    const r = motivosLegibles({ dianStatus: 'rejected', rechazoMotivo: 'uno; dos' });
    expect(r.map((x) => x.texto)).toEqual(['uno', 'dos']);
  });
  it('suma por qué el último intento no salió a la red, con su sugerencia por código', () => {
    const r = motivosLegibles({
      dianStatus: 'signed',
      ultimoIntentoSinRed: { codigo: 'CONFIG_FALTANTE', motivos: ['Falta el certificado'] },
    });
    expect(r[0]!.texto).toBe('Falta el certificado');
    expect(r[0]!.sugerencia).toMatch(/Falta configurar/);
  });
  it('acota la cantidad', () => {
    const mensajes = Array.from({ length: 30 }, (_, i) => `m${i}`);
    expect(motivosLegibles({ dianStatus: 'rejected', respuestaDian: { mensajes } })).toHaveLength(10);
  });
});

describe('resumenEstado', () => {
  it('cubre los estados', () => {
    expect(resumenEstado('accepted')).toMatch(/Aceptado/);
    expect(resumenEstado('rejected')).toMatch(/Rechazado/);
    expect(resumenEstado('draft')).toMatch(/Generado/);
  });
});
