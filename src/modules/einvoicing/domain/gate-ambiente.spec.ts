import { describe, expect, it } from 'vitest';
import {
  decidirAmbiente,
  esResolucionDePruebas,
  type EntradaGateAmbiente,
} from './gate-ambiente';

const NIT = '900123456';

/** Producción lista para transmitir; cada caso rompe una sola cosa. */
const prod = (cambios: Partial<{
  emisor: Partial<NonNullable<EntradaGateAmbiente['emisor']>> | null;
  resolucion: EntradaGateAmbiente['resolucion'];
  documento: Partial<EntradaGateAmbiente['documento']>;
}> = {}): EntradaGateAmbiente => ({
  emisor:
    cambios.emisor === null
      ? null
      : { tipoAmbiente: '1', habilitado: true, nitNorm: NIT, faltaParaTransmitir: [], ...cambios.emisor },
  resolucion: 'resolucion' in cambios ? cambios.resolucion : { prefijo: 'FE', numero: '18764000000001' },
  documento: { tipo: 'invoice', tipoAmbiente: '1', nitNorm: NIT, cufe: 'abc', ...cambios.documento },
});

/** Habilitación con la resolución de pruebas. */
const hab = (cambios: Parameters<typeof prod>[0] = {}): EntradaGateAmbiente =>
  prod({
    resolucion: { prefijo: 'SETP', numero: '18760000001' },
    ...cambios,
    emisor: cambios.emisor === null ? null : { tipoAmbiente: '2', habilitado: false, ...cambios.emisor },
    documento: { tipoAmbiente: '2', ...cambios.documento },
  });

const motivos = (e: EntradaGateAmbiente): string[] => {
  const d = decidirAmbiente(e);
  if (d.permitido) throw new Error('se esperaba rechazo');
  expect(d.codigo).toBe('CONFIG_FALTANTE');
  return d.motivos;
};

describe('gate de ambiente', () => {
  it('producción completa: transmite a producción', () => {
    expect(decidirAmbiente(prod())).toEqual({ permitido: true, ambiente: '1' });
  });

  it('habilitación con resolución SETP: transmite a habilitación aunque no esté habilitado', () => {
    expect(decidirAmbiente(hab())).toEqual({ permitido: true, ambiente: '2' });
  });

  it('producción sin emisor habilitado: no transmite', () => {
    expect(motivos(prod({ emisor: { habilitado: false } }))).toContain(
      'el emisor no está habilitado para producción',
    );
    expect(motivos(prod({ emisor: { habilitado: undefined } }))).toContain(
      'el emisor no está habilitado para producción',
    );
  });

  it('producción con resolución de pruebas (prefijo SETP o número de pruebas): no transmite', () => {
    expect(motivos(prod({ resolucion: { prefijo: 'setp', numero: '1' } }))).toContain(
      'la resolución de pruebas (SETP) no sirve en producción',
    );
    expect(motivos(prod({ resolucion: { prefijo: 'FE', numero: '18760000001' } }))).toContain(
      'la resolución de pruebas (SETP) no sirve en producción',
    );
  });

  it('producción: factura y POS sin resolución no transmiten; la nota crédito sí', () => {
    expect(motivos(prod({ resolucion: null }))).toContain('el documento no tiene resolución de numeración');
    expect(motivos(prod({ resolucion: null, documento: { tipo: 'pos' } }))).toContain(
      'el documento no tiene resolución de numeración',
    );
    expect(decidirAmbiente(prod({ resolucion: null, documento: { tipo: 'credit_note' } }))).toEqual({
      permitido: true,
      ambiente: '1',
    });
  });

  it('un documento de pruebas jamás va a producción', () => {
    expect(motivos(prod({ documento: { tipoAmbiente: '2' } }))).toContain(
      'un documento de pruebas no se transmite a producción',
    );
  });

  it('un documento de producción no se degrada a habilitación en silencio', () => {
    expect(motivos(hab({ documento: { tipoAmbiente: '1' } }))).toContain(
      'un documento de producción no se transmite a habilitación',
    );
  });

  it('documento sin ambiente (anterior a la Fase 2): no transmite', () => {
    expect(motivos(prod({ documento: { tipoAmbiente: undefined } }))).toContain(
      'el documento no indica con qué ambiente se calculó su CUFE/CUDE',
    );
  });

  it('ambiente del emisor desconocido: no se asume habilitación', () => {
    const m = motivos(prod({ emisor: { tipoAmbiente: '3' } }));
    expect(m).toContain('el emisor no tiene un ambiente DIAN válido');
    expect(motivos(prod({ emisor: { tipoAmbiente: undefined } }))).toContain(
      'el emisor no tiene un ambiente DIAN válido',
    );
  });

  it('habilitación no gasta una resolución real', () => {
    expect(motivos(hab({ resolucion: { prefijo: 'FE', numero: '18764000000001' } }))).toContain(
      'en habilitación solo se usa la resolución de pruebas (SETP)',
    );
    // La nota crédito sin resolución sí pasa en habilitación.
    expect(decidirAmbiente(hab({ resolucion: null, documento: { tipo: 'credit_note' } }))).toEqual({
      permitido: true,
      ambiente: '2',
    });
  });

  it('sin emisor, con credenciales faltantes, sin CUFE o con NIT distinto: no transmite', () => {
    expect(motivos(prod({ emisor: null }))).toEqual(['la sede no tiene emisor fiscal']);
    expect(motivos(prod({ emisor: { faltaParaTransmitir: ['PIN del software'] } }))).toContain(
      'falta PIN del software',
    );
    expect(motivos(prod({ documento: { cufe: '' } }))).toContain('el documento no tiene CUFE/CUDE');
    expect(motivos(prod({ documento: { nitNorm: '800000000' } }))).toContain(
      'el NIT del documento no coincide con el del emisor fiscal',
    );
    expect(motivos(prod({ documento: { nitNorm: undefined } }))).toContain(
      'el NIT del documento no coincide con el del emisor fiscal',
    );
  });

  it('reúne todos los motivos a la vez', () => {
    const m = motivos(prod({ emisor: { habilitado: false }, resolucion: { prefijo: 'SETP' }, documento: { tipoAmbiente: '2' } }));
    expect(m.length).toBeGreaterThanOrEqual(3);
  });

  it('esResolucionDePruebas', () => {
    expect(esResolucionDePruebas({ prefijo: ' SETP ' })).toBe(true);
    expect(esResolucionDePruebas({ numero: '18760000001' })).toBe(true);
    expect(esResolucionDePruebas({ prefijo: 'FE', numero: '187' })).toBe(false);
    expect(esResolucionDePruebas(null)).toBe(false);
  });
});
