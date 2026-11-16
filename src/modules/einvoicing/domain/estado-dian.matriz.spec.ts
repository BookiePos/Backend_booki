import { describe, expect, it } from 'vitest';
import { DIAN_STATUS, type DianStatus } from './einvoicing.constants';
import { CODIGOS_SIN_VEREDICTO, estadoTrasRespuesta, transicionPermitida } from './estado-dian';
import type { OrigenRespuesta, RespuestaDian } from './transmisor-dian';

/**
 * Fase 11 · máquina de estados y lista negra de veredictos, matriz completa:
 * los seis estados × todas las respuestas posibles (origen × IsValid × código).
 * `estado-dian.spec.ts` prueba casos sueltos; aquí se fijan las reglas que no
 * pueden romperse en NINGUNA combinación:
 *
 *  - `rejected` y `accepted` solo salen de `sent` y solo con un veredicto de la
 *    DIAN (origen dian, IsValid booleano, código fuera de la lista negra).
 *  - Un código de la lista negra nunca mueve a un veredicto, ni con IsValid.
 *  - Lo que la función devuelve es siempre el mismo estado o una transición
 *    permitida: no hay saltos.
 */

const ORIGENES: OrigenRespuesta[] = ['adapter', 'dian'];
const IS_VALID: Array<boolean | undefined> = [undefined, true, false];
const CODIGOS: Array<string | undefined> = [undefined, '00', '99', '66', 'FAD06', '', ...CODIGOS_SIN_VEREDICTO];
const enListaNegra = (c: string | undefined): boolean => c !== undefined && (CODIGOS_SIN_VEREDICTO as readonly string[]).includes(c);

interface Caso {
  actual: DianStatus;
  r: RespuestaDian;
}

/** Todas las respuestas que cumplen el contrato (`ok` es bicondicional). */
function* casos(): Generator<Caso> {
  for (const actual of DIAN_STATUS)
    for (const origen of ORIGENES)
      for (const isValid of IS_VALID)
        for (const codigo of CODIGOS)
          yield {
            actual,
            r: {
              ok: isValid === true && origen === 'dian',
              origen,
              mensajes: [],
              ...(isValid === undefined ? {} : { isValid }),
              ...(codigo === undefined ? {} : { codigo }),
            },
          };
}

const ver = (c: Caso): string => `${c.actual} + ${JSON.stringify(c.r)}`;
const aplicar = (c: Caso): DianStatus | 'lanza' => {
  try {
    return estadoTrasRespuesta(c.actual, c.r);
  } catch {
    return 'lanza';
  }
};

describe('estadoTrasRespuesta · matriz completa (estados × origen × IsValid × código)', () => {
  it('coincide con la regla escrita aparte en las 6 × 2 × 3 × 11 combinaciones', () => {
    let n = 0;
    for (const c of casos()) {
      n += 1;
      const veredicto = c.r.origen === 'dian' && typeof c.r.isValid === 'boolean' && !enListaNegra(c.r.codigo);
      let esperado: DianStatus | 'lanza';
      if (veredicto) esperado = c.actual === 'sent' ? (c.r.isValid ? 'accepted' : 'rejected') : 'lanza';
      else if (c.actual === 'signed' && c.r.codigo !== 'CONFIG_FALTANTE') esperado = 'sent';
      else esperado = c.actual;
      expect(aplicar(c), ver(c)).toBe(esperado);
    }
    expect(n).toBe(DIAN_STATUS.length * ORIGENES.length * IS_VALID.length * CODIGOS.length);
  });

  it('rejected solo sale de sent, con origen dian, IsValid=false y un código fuera de la lista negra', () => {
    let vistos = 0;
    for (const c of casos()) {
      if (aplicar(c) !== 'rejected' || c.actual === 'rejected') continue;
      vistos += 1;
      expect(c.actual, ver(c)).toBe('sent');
      expect(c.r.origen, ver(c)).toBe('dian');
      expect(c.r.isValid, ver(c)).toBe(false);
      expect(enListaNegra(c.r.codigo), ver(c)).toBe(false);
    }
    expect(vistos).toBeGreaterThan(0);
  });

  it('accepted solo sale de sent, con origen dian, IsValid=true y un código fuera de la lista negra', () => {
    let vistos = 0;
    for (const c of casos()) {
      if (aplicar(c) !== 'accepted' || c.actual === 'accepted') continue;
      vistos += 1;
      expect(c.actual, ver(c)).toBe('sent');
      expect(c.r).toMatchObject({ origen: 'dian', isValid: true, ok: true });
      expect(enListaNegra(c.r.codigo), ver(c)).toBe(false);
    }
    expect(vistos).toBeGreaterThan(0);
  });

  it.each(CODIGOS_SIN_VEREDICTO)('%s: en ningún estado, origen ni IsValid produce accepted o rejected', (codigo) => {
    for (const c of casos()) {
      if (c.r.codigo !== codigo) continue;
      const fin = aplicar(c);
      expect(fin, ver(c)).not.toBe('lanza');
      if (c.actual !== 'accepted') expect(fin, ver(c)).not.toBe('accepted');
      if (c.actual !== 'rejected') expect(fin, ver(c)).not.toBe('rejected');
    }
  });

  it('nada que venga del adaptador (red, timeout, configuración) acepta ni rechaza, traiga lo que traiga', () => {
    for (const c of casos()) {
      if (c.r.origen !== 'adapter') continue;
      const fin = aplicar(c);
      expect(fin === c.actual || (c.actual === 'signed' && fin === 'sent'), ver(c)).toBe(true);
    }
  });

  it('el resultado es el mismo estado o una transición permitida: no hay saltos', () => {
    for (const c of casos()) {
      const fin = aplicar(c);
      if (fin === 'lanza' || fin === c.actual) continue;
      expect(transicionPermitida(c.actual, fin), ver(c)).toBe(true);
    }
  });

  it('un aceptado, un rechazado, un borrador y uno en contingencia no se mueven con ninguna respuesta', () => {
    for (const c of casos()) {
      if (!['accepted', 'rejected', 'draft', 'contingency'].includes(c.actual)) continue;
      const fin = aplicar(c);
      expect(fin === c.actual || fin === 'lanza', ver(c)).toBe(true);
    }
  });

  it('una respuesta fuera de contrato (ok que no corresponde) lanza en todos los estados, sin mover nada', () => {
    for (const c of casos()) {
      expect(() => estadoTrasRespuesta(c.actual, { ...c.r, ok: !c.r.ok }), ver(c)).toThrow(/Respuesta DIAN inválida/);
    }
  });
});

describe('transiciones · lo que nunca se permite', () => {
  it('ningún estado vuelve a draft y de accepted no se sale', () => {
    for (const desde of DIAN_STATUS) {
      expect(transicionPermitida(desde, 'draft'), desde).toBe(false);
      expect(transicionPermitida('accepted', desde), desde).toBe(false);
    }
  });

  it('a accepted y a rejected solo se entra desde sent', () => {
    for (const desde of DIAN_STATUS) {
      expect(transicionPermitida(desde, 'accepted'), desde).toBe(desde === 'sent');
      expect(transicionPermitida(desde, 'rejected'), desde).toBe(desde === 'sent');
    }
  });

  it('de rejected solo se sale volviendo a firmar (mismo número), nunca directo a la red', () => {
    for (const hacia of DIAN_STATUS) expect(transicionPermitida('rejected', hacia), hacia).toBe(hacia === 'signed');
  });
});
