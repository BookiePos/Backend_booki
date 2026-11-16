import { describe, expect, it } from 'vitest';
import { DOC_TYPES, type DocType } from './einvoicing.constants';
import { decidirAmbiente, type EntradaGateAmbiente, type ResolucionParaGate } from './gate-ambiente';

/**
 * Fase 11 · gate de ambiente, matriz completa. `gate-ambiente.spec.ts` rompe
 * una cosa por caso; aquí se cruzan TODAS las combinaciones (también valores
 * que el tipo no admite pero una base de datos sí puede traer) contra un
 * oráculo escrito aparte. Lo que protege: que nada llegue a producción sin
 * emisor habilitado, ambiente 1 en emisor y documento, y resolución real.
 */

const NIT = '900123456';

const AMBIENTES_EMISOR: unknown[] = ['1', '2', undefined, null, '', ' 1', '1 ', '01', 'produccion', 1, 2, true, 'toString', '__proto__'];
const HABILITADO: unknown[] = [true, false, null, undefined, 'true', 1, {}];
const AMBIENTES_DOC: unknown[] = ['1', '2', undefined, null, '', '3', 1];
const RESOLUCIONES: Record<string, ResolucionParaGate | null | undefined> = {
  real: { prefijo: 'FE', numero: '18764000000001' },
  'real sin prefijo': { prefijo: undefined, numero: '18764000000001' },
  'pruebas por prefijo': { prefijo: 'SETP', numero: '18764000000001' },
  'pruebas por prefijo en minúsculas y con espacios': { prefijo: ' setp ', numero: '1' },
  'pruebas por número': { prefijo: 'FE', numero: ' 18760000001 ' },
  'sin número': { prefijo: 'FE', numero: '' },
  'número en blanco': { prefijo: 'FE', numero: '   ' },
  vacía: {},
  null: null,
  undefined: undefined,
};
const NITS_DOC: Array<string | null | undefined> = [NIT, '900999999', '', null, undefined];
const CUFES: Array<string | null | undefined> = ['a'.repeat(96), '', '   ', null, undefined];
const FALTAS: Array<readonly string[] | undefined> = [[], undefined, ['el PIN del software']];

const esPruebas = (r: ResolucionParaGate | null | undefined): boolean =>
  !!r && ((r.prefijo ?? '').trim().toUpperCase() === 'SETP' || (r.numero ?? '').trim() === '18760000001');
const tieneNumero = (r: ResolucionParaGate | null | undefined): boolean => !!r && (r.numero ?? '').trim() !== '';
const EXIGEN_RESOLUCION: readonly DocType[] = ['invoice', 'pos'];

/** Oráculo: a qué ambiente puede salir, o `null` si no puede. Escrito sin mirar el orden del gate. */
function oraculo(e: EntradaGateAmbiente): '1' | '2' | null {
  const em = e.emisor;
  if (!em) return null;
  if ((em.faltaParaTransmitir ?? []).length > 0) return null;
  if (typeof e.documento.cufe !== 'string' || e.documento.cufe.trim() === '') return null;
  if (!em.nitNorm || em.nitNorm !== e.documento.nitNorm) return null;
  if (em.tipoAmbiente !== e.documento.tipoAmbiente) return null;
  if (em.tipoAmbiente === '1') {
    if (em.habilitado !== true) return null;
    if (esPruebas(e.resolucion)) return null;
    if (EXIGEN_RESOLUCION.includes(e.documento.tipo) && !tieneNumero(e.resolucion)) return null;
    return '1';
  }
  if (em.tipoAmbiente === '2') {
    if (e.resolucion && !esPruebas(e.resolucion)) return null;
    return '2';
  }
  return null;
}

function* combinaciones(): Generator<EntradaGateAmbiente> {
  for (const tipoAmbiente of AMBIENTES_EMISOR)
    for (const habilitado of HABILITADO)
      for (const ambDoc of AMBIENTES_DOC)
        for (const resolucion of Object.values(RESOLUCIONES))
          for (const tipo of DOC_TYPES)
            for (const nitDoc of NITS_DOC)
              for (const cufe of CUFES)
                for (const faltaParaTransmitir of FALTAS)
                  yield {
                    emisor: { tipoAmbiente, habilitado, nitNorm: NIT, faltaParaTransmitir } as EntradaGateAmbiente['emisor'],
                    resolucion,
                    documento: { tipo, tipoAmbiente: ambDoc, nitNorm: nitDoc, cufe } as EntradaGateAmbiente['documento'],
                  };
}

const ver = (e: EntradaGateAmbiente): string => JSON.stringify(e, (_k, v) => (v === undefined ? '«undefined»' : v));

describe('gate de ambiente · matriz completa contra un oráculo', () => {
  it('cada combinación decide lo que dice el oráculo, y un rechazo siempre trae motivos', () => {
    const fallas: string[] = [];
    let total = 0;
    let aProduccion = 0;
    let aHabilitacion = 0;
    for (const e of combinaciones()) {
      total += 1;
      const d = decidirAmbiente(e);
      const esperado = oraculo(e);
      const obtenido = d.permitido ? d.ambiente : null;
      if (obtenido !== esperado) fallas.push(`esperado ${String(esperado)}, obtenido ${String(obtenido)}: ${ver(e)}`);
      if (!d.permitido && (d.codigo !== 'CONFIG_FALTANTE' || d.motivos.length === 0)) fallas.push(`rechazo sin motivos: ${ver(e)}`);
      if (obtenido === '1') aProduccion += 1;
      if (obtenido === '2') aHabilitacion += 1;
      if (fallas.length >= 5) break;
    }
    expect(fallas).toEqual([]);
    // La matriz no está vacía de ningún lado: hay permitidos en los dos ambientes y son minoría.
    expect(total).toBeGreaterThan(100_000);
    expect(aProduccion).toBeGreaterThan(0);
    expect(aHabilitacion).toBeGreaterThan(0);
    expect(aProduccion + aHabilitacion).toBeLessThan(total / 100);
  });

  it('a producción solo se llega con habilitado === true, ambiente «1» exacto en emisor y documento, y sin resolución de pruebas', () => {
    for (const e of combinaciones()) {
      const d = decidirAmbiente(e);
      if (!d.permitido || d.ambiente !== '1') continue;
      const contexto = ver(e);
      expect(e.emisor?.habilitado, contexto).toBe(true);
      expect(e.emisor?.tipoAmbiente, contexto).toBe('1');
      expect(e.documento.tipoAmbiente, contexto).toBe('1');
      expect(esPruebas(e.resolucion), contexto).toBe(false);
      expect(e.documento.nitNorm, contexto).toBe(NIT);
      if (EXIGEN_RESOLUCION.includes(e.documento.tipo)) expect(tieneNumero(e.resolucion), contexto).toBe(true);
    }
  });

  it('nunca devuelve un ambiente distinto del que tiene congelado el documento', () => {
    for (const e of combinaciones()) {
      const d = decidirAmbiente(e);
      if (d.permitido) expect(d.ambiente, ver(e)).toBe(e.documento.tipoAmbiente);
    }
  });

  it('sin emisor no hay nada que cruzar: ningún documento sale', () => {
    for (const emisor of [null, undefined]) {
      for (const tipo of DOC_TYPES) {
        const d = decidirAmbiente({
          emisor,
          resolucion: RESOLUCIONES.real,
          documento: { tipo, tipoAmbiente: '1', nitNorm: NIT, cufe: 'a'.repeat(96) },
        });
        expect(d).toEqual({ permitido: false, codigo: 'CONFIG_FALTANTE', motivos: ['la sede no tiene emisor fiscal'] });
      }
    }
  });

  it.each(['invoice', 'pos'] as const)(
    'producción · %s: una resolución sin número no es una resolución real (subdocumento vacío)',
    (tipo) => {
      for (const resolucion of [RESOLUCIONES.vacía, RESOLUCIONES['sin número'], RESOLUCIONES['número en blanco']]) {
        const d = decidirAmbiente({
          emisor: { tipoAmbiente: '1', habilitado: true, nitNorm: NIT, faltaParaTransmitir: [] },
          resolucion,
          documento: { tipo, tipoAmbiente: '1', nitNorm: NIT, cufe: 'a'.repeat(96) },
        });
        expect(d).toMatchObject({ permitido: false, motivos: ['el documento no tiene resolución de numeración'] });
      }
    },
  );
});
