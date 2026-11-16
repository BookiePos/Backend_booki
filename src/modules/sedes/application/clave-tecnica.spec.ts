import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretoIlegibleError, VARIABLE_LLAVE, esSecretoCifrado } from '../../../shared/crypto/secretos';
import { calcularCufe } from '../../einvoicing/domain/cufe';
import { computeResolutionStatus } from '../../einvoicing/domain/resolution-status';
import {
  camposClaveAlGuardar,
  cifrarClaveTecnica,
  ClaveTecnicaSinLlaveError,
  contextoClaveTecnica,
  leerClaveTecnicaDe,
  tieneClaveTecnica,
} from './clave-tecnica';

describe('clave técnica de la resolución · cifrado, contexto y lectura con respaldo', () => {
  const env = { [VARIABLE_LLAVE]: randomBytes(32).toString('base64') };
  const sinLlave = {};
  const SEDE = '66f000000000000000000001';
  const OTRA = '66f000000000000000000002';
  const CLAVE = 'clave-de-prueba-0001'; // secretos-ok

  it('el contexto ata la clave a la sede y al tipo de documento', () => {
    expect(contextoClaveTecnica(SEDE, 'invoice')).toBe(`${SEDE}:resolucion.invoice.claveTecnica`);
    expect(contextoClaveTecnica(SEDE, 'pos')).not.toBe(contextoClaveTecnica(SEDE, 'invoice'));
  });

  it('cifra y descifra; el cifrado no contiene la clave y cambia en cada llamada', () => {
    const a = cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env });
    const b = cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env });
    expect(esSecretoCifrado(a)).toBe(true);
    expect(JSON.stringify(a)).not.toContain(CLAVE);
    expect(a.data).not.toBe(b.data);
    expect(leerClaveTecnicaDe(SEDE, { claveTecnicaCifrada: a }, { env })).toBe(CLAVE);
  });

  it('sin tipoDocumento se lee como factura (resoluciones anteriores a la división por tipo)', () => {
    const s = cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env });
    expect(leerClaveTecnicaDe(SEDE, { tipoDocumento: 'invoice', claveTecnicaCifrada: s }, { env })).toBe(CLAVE);
    expect(leerClaveTecnicaDe(SEDE, { claveTecnicaCifrada: s }, { env })).toBe(CLAVE);
  });

  it('trasplantada a otra sede, a otro tipo o alterada: lanza, nunca devuelve basura', () => {
    const s = cifrarClaveTecnica(SEDE, 'pos', CLAVE, { env });
    const leer = (sede: string, tipo: 'pos' | 'invoice', secreto = s) => () =>
      leerClaveTecnicaDe(sede, { tipoDocumento: tipo, claveTecnicaCifrada: secreto }, { env });
    expect(leer(SEDE, 'pos')()).toBe(CLAVE);
    expect(leer(OTRA, 'pos')).toThrow(SecretoIlegibleError);
    expect(leer(SEDE, 'invoice')).toThrow(SecretoIlegibleError);
    expect(leer(SEDE, 'pos', { ...s, data: Buffer.from('otra-cosa').toString('base64') })).toThrow(SecretoIlegibleError);
    const otraLlave = { [VARIABLE_LLAVE]: randomBytes(32).toString('base64') };
    expect(() => leerClaveTecnicaDe(SEDE, { tipoDocumento: 'pos', claveTecnicaCifrada: s }, { env: otraLlave })).toThrow(
      SecretoIlegibleError,
    );
  });

  it('sin llave: cifrar lanza y leer una clave cifrada lanza (no se hace pasar por «sin clave»)', () => {
    expect(() => cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env: sinLlave })).toThrow(VARIABLE_LLAVE);
    const s = cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env });
    expect(() => leerClaveTecnicaDe(SEDE, { claveTecnicaCifrada: s }, { env: sinLlave })).toThrow(ClaveTecnicaSinLlaveError);
    // El error no lleva la clave ni el cifrado.
    try {
      leerClaveTecnicaDe(SEDE, { claveTecnicaCifrada: s }, { env: sinLlave });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(s.data);
    }
  });

  it('respaldo: sin campo cifrado cae a la clave vieja en claro, incluso sin llave', () => {
    expect(leerClaveTecnicaDe(SEDE, { claveTecnica: ` ${CLAVE} ` }, { env: sinLlave })).toBe(CLAVE);
    expect(leerClaveTecnicaDe(SEDE, { claveTecnica: '  ' }, { env })).toBeUndefined();
    expect(leerClaveTecnicaDe(SEDE, {}, { env })).toBeUndefined();
    expect(leerClaveTecnicaDe(SEDE, undefined, { env })).toBeUndefined();
  });

  it('si hay cifrada y en claro, manda la cifrada', () => {
    const s = cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env });
    expect(leerClaveTecnicaDe(SEDE, { claveTecnicaCifrada: s, claveTecnica: 'vieja' }, { env })).toBe(CLAVE);
  });

  it('lee el secreto cuando llega como subdocumento de Mongoose', () => {
    const s = cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env });
    const subdoc = { toObject: () => ({ ...s }) } as never;
    expect(leerClaveTecnicaDe(SEDE, { claveTecnicaCifrada: subdoc }, { env })).toBe(CLAVE);
  });

  it('tieneClaveTecnica: marca, cifrada o claro; nunca descifra', () => {
    expect(tieneClaveTecnica(undefined)).toBe(false);
    expect(tieneClaveTecnica({})).toBe(false);
    expect(tieneClaveTecnica({ claveTecnica: ' ' })).toBe(false);
    expect(tieneClaveTecnica({ claveTecnica: 'x' })).toBe(true);
    expect(tieneClaveTecnica({ tieneClaveTecnica: true })).toBe(true);
    expect(tieneClaveTecnica({ claveTecnicaCifrada: { iv: '', tag: '', data: '', v: 1 } })).toBe(true);
  });

  describe('camposClaveAlGuardar', () => {
    it('clave nueva: cifrada, sin claro y con la marca', () => {
      const c = camposClaveAlGuardar(SEDE, 'pos', ` ${CLAVE} `, { claveTecnica: 'vieja' }, { env });
      expect(c.claveTecnica).toBeUndefined();
      expect(c.tieneClaveTecnica).toBe(true);
      expect(leerClaveTecnicaDe(SEDE, { tipoDocumento: 'pos', ...c }, { env })).toBe(CLAVE);
    });

    it('clave nueva sin llave: lanza, no devuelve nada que guardar', () => {
      expect(() => camposClaveAlGuardar(SEDE, 'pos', CLAVE, null, { env: sinLlave })).toThrow(VARIABLE_LLAVE);
    });

    it('sin clave nueva (ausente o vacía): conserva la cifrada tal cual, sin necesitar la llave', () => {
      const s = cifrarClaveTecnica(SEDE, 'invoice', CLAVE, { env });
      for (const nueva of [undefined, null, '', '   ']) {
        const c = camposClaveAlGuardar(SEDE, 'invoice', nueva, { claveTecnicaCifrada: s }, { env: sinLlave });
        expect(c).toEqual({ claveTecnicaCifrada: s, claveTecnica: undefined, tieneClaveTecnica: true });
      }
    });

    it('sin clave nueva y con la vieja en claro: la conserva en claro hasta la migración', () => {
      expect(camposClaveAlGuardar(SEDE, 'invoice', undefined, { claveTecnica: 'vieja' }, { env })).toEqual({
        claveTecnicaCifrada: undefined,
        claveTecnica: 'vieja',
        tieneClaveTecnica: true,
      });
      expect(camposClaveAlGuardar(SEDE, 'invoice', undefined, null, { env })).toEqual({
        claveTecnicaCifrada: undefined,
        claveTecnica: undefined,
        tieneClaveTecnica: false,
      });
    });
  });

  it('el CUFE con la clave leída del campo cifrado es el mismo que con la clave en claro', () => {
    const datos = {
      numero: 'FE12',
      fecha: '2026-11-14',
      hora: '10:00:00-05:00',
      valorBruto: 10000,
      impuestos: { '01': 1900, '04': 0, '03': 0 },
      valorTotal: 11900,
      nitEmisor: '900123456',
      numAdquiriente: '222222222222',
      tipoAmbiente: '2' as const,
    };
    const guardada = camposClaveAlGuardar(SEDE, 'invoice', CLAVE, null, { env });
    const leida = leerClaveTecnicaDe(SEDE, guardada, { env }) as string;
    const esperado = calcularCufe({ ...datos, claveTecnica: CLAVE });
    expect(calcularCufe({ ...datos, claveTecnica: leida })).toBe(esperado);
    expect(esperado).toMatch(/^[0-9a-f]{96}$/);
  });

  it('el estado de la resolución da claveTecnicaOk con la marca, la cifrada o el claro', () => {
    const base = { numero: '1', rangoDesde: 1, rangoHasta: 10 };
    expect(computeResolutionStatus(base, 1).claveTecnicaOk).toBe(false);
    expect(computeResolutionStatus({ ...base, tieneClaveTecnica: true }, 1).claveTecnicaOk).toBe(true);
    expect(computeResolutionStatus({ ...base, claveTecnica: 'x' }, 1).claveTecnicaOk).toBe(true);
    expect(computeResolutionStatus({ ...base, claveTecnicaCifrada: { iv: '' } }, 1).claveTecnicaOk).toBe(true);
  });
});
