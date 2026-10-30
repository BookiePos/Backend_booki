import { describe, expect, it } from 'vitest';
import {
  avisoCertificado,
  CertificadoInvalidoError,
  nitCoincide,
  validarCertificadoP12,
  type MotivoRechazoCertificado,
} from './certificado-p12';
import { p12DePrueba } from './p12-de-prueba.test';

const NIT = '900123456';
const PASS = 'clave-de-prueba';
const DIA = 86_400_000;

function motivo(fn: () => unknown): MotivoRechazoCertificado | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof CertificadoInvalidoError) return err.motivo;
    throw err;
  }
  return undefined;
}

describe('validarCertificadoP12', () => {
  it('acepta un .p12 válido y devuelve vencimiento, titular y huella', () => {
    const r = validarCertificadoP12(p12DePrueba(), PASS, NIT);
    expect(r.venceAt.getTime()).toBeGreaterThan(Date.now());
    expect(r.titular).toBe('CRUNCHY PRUEBAS SAS');
    expect(r.emisorCertificado).toBe('ECD DE PRUEBA BOOKIPOS');
    expect(r.huellaSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rechaza la contraseña mala', () => {
    expect(motivo(() => validarCertificadoP12(p12DePrueba(), 'mala', NIT))).toBe('password');
  });

  it('rechaza lo que no es un .p12', () => {
    expect(motivo(() => validarCertificadoP12(Buffer.from('hola mundo'), PASS, NIT))).toBe('formato');
  });

  it('rechaza un .p12 sin llave privada', () => {
    expect(motivo(() => validarCertificadoP12(p12DePrueba({ conLlave: false }), PASS, NIT))).toBe('sin-llave');
  });

  it('rechaza un certificado vencido', () => {
    const p12 = p12DePrueba({ desde: new Date(Date.now() - 400 * DIA), hasta: new Date(Date.now() - DIA) });
    expect(motivo(() => validarCertificadoP12(p12, PASS, NIT))).toBe('vencido');
  });

  it('rechaza un certificado que aún no está vigente', () => {
    const p12 = p12DePrueba({ desde: new Date(Date.now() + DIA), hasta: new Date(Date.now() + 400 * DIA) });
    expect(motivo(() => validarCertificadoP12(p12, PASS, NIT))).toBe('aun-no-vigente');
  });

  it('rechaza un certificado autofirmado', () => {
    expect(motivo(() => validarCertificadoP12(p12DePrueba({ autofirmado: true }), PASS, NIT))).toBe('autofirmado');
  });

  it('rechaza una cadena que no cuadra', () => {
    expect(motivo(() => validarCertificadoP12(p12DePrueba({ cadenaRota: true }), PASS, NIT))).toBe('cadena');
  });

  it('sin la cadena en el .p12 basta con que no sea autofirmado', () => {
    expect(() => validarCertificadoP12(p12DePrueba({ conCadena: false }), PASS, NIT)).not.toThrow();
  });

  it('rechaza un certificado de otro NIT', () => {
    expect(motivo(() => validarCertificadoP12(p12DePrueba({ nit: '800999888' }), PASS, NIT))).toBe('nit');
  });

  it('rechaza la firma SHA-1', () => {
    expect(motivo(() => validarCertificadoP12(p12DePrueba({ sha1: true }), PASS, NIT))).toBe('algoritmo-debil');
  });

  it('rechaza un certificado sin uso de firma', () => {
    expect(motivo(() => validarCertificadoP12(p12DePrueba({ keyUsage: { keyEncipherment: true } }), PASS, NIT))).toBe(
      'uso-llave',
    );
    expect(motivo(() => validarCertificadoP12(p12DePrueba({ keyUsage: false }), PASS, NIT))).toBe('uso-llave');
  });

  it('acepta solo «no repudio» o solo «firma digital»', () => {
    expect(() => validarCertificadoP12(p12DePrueba({ keyUsage: { nonRepudiation: true } }), PASS, NIT)).not.toThrow();
    expect(() =>
      validarCertificadoP12(p12DePrueba({ keyUsage: { digitalSignature: true } }), PASS, NIT),
    ).not.toThrow();
  });

  it('el mensaje de rechazo no filtra el NIT del certificado', () => {
    try {
      validarCertificadoP12(p12DePrueba({ nit: '800999888' }), PASS, NIT);
    } catch (err) {
      expect((err as Error).message).not.toContain('800999888');
      expect((err as Error).message).toMatch(/NIT/);
    }
  });

  describe('dónde viene el NIT', () => {
    const casos: Array<[string, Array<{ name?: string; type?: string; value: string }>]> = [
      ['serialNumber con DV (GSE/Andes)', [{ name: 'serialNumber', value: 'NIT 900.123.456-8' }]],
      ['arco Certicámara 1.3.6.1.4.1.23267.2.3', [{ type: '1.3.6.1.4.1.23267.2.3', value: '900123456' }]],
      ['x500UniqueIdentifier', [{ type: '2.5.4.45', value: '900123456' }]],
      ['organizationIdentifier ETSI', [{ type: '2.5.4.97', value: 'NITCO-900123456' }]],
      ['dentro del CN', [{ name: 'organizationName', value: 'X' }]],
    ];
    it.each(casos)('%s', (nombre, extra) => {
      const cn = nombre === 'dentro del CN' ? 'CRUNCHY SAS NIT 900123456' : 'CRUNCHY SAS';
      const p12 = p12DePrueba({ sujeto: [{ name: 'commonName', value: cn }, ...extra] });
      const r = validarCertificadoP12(p12, PASS, NIT);
      // El titular nunca lleva el número de identificación.
      expect(r.titular).not.toMatch(/\d{5,}/);
    });

    it('sin NIT en ningún atributo conocido, rechaza', () => {
      const p12 = p12DePrueba({ sujeto: [{ name: 'commonName', value: 'CRUNCHY SAS' }] });
      expect(motivo(() => validarCertificadoP12(p12, PASS, NIT))).toBe('nit');
    });
  });
});

describe('nitCoincide', () => {
  it('igual, o con el DV correcto pegado de cualquier lado', () => {
    expect(nitCoincide('900123456', '900123456')).toBe(true);
    expect(nitCoincide('9001234568', '900123456')).toBe(true);
    expect(nitCoincide('900123456', '9001234568')).toBe(true);
  });
  it('un dígito de más que no es el DV no pasa', () => {
    expect(nitCoincide('9001234561', '900123456')).toBe(false);
    expect(nitCoincide('800123456', '900123456')).toBe(false);
    expect(nitCoincide('', '900123456')).toBe(false);
  });
});

describe('avisoCertificado', () => {
  const ahora = new Date('2026-10-30T12:00:00Z');
  it('marca por vencer a 30 días o menos y vencido si pasó', () => {
    expect(avisoCertificado(new Date(ahora.getTime() + 31 * DIA), ahora)).toBeNull();
    expect(avisoCertificado(new Date(ahora.getTime() + 30 * DIA), ahora)).toBe('por-vencer');
    expect(avisoCertificado(new Date(ahora.getTime() + 1000), ahora)).toBe('por-vencer');
    expect(avisoCertificado(ahora, ahora)).toBe('vencido');
    expect(avisoCertificado(undefined, ahora)).toBeNull();
  });
});
