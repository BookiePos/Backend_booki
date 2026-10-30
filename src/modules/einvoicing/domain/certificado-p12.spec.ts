import { describe, expect, it, vi } from 'vitest';
import forge from 'node-forge';
import {
  avisoCertificado,
  CertificadoInvalidoError,
  MAX_CERT_BAGS_P12,
  MAX_CONTENIDOS_P12,
  MAX_ITERACIONES_P12,
  PRESUPUESTO_ITERACIONES_P12,
  nitCoincide,
  nitDelEmisor,
  validarCertificadoP12,
  type MotivoRechazoCertificado,
} from './certificado-p12';
import {
  conCertsCifrados,
  conContenidosRepetidos,
  conIteracionesContenido,
  conIteracionesLlave,
  conIteracionesMac,
  conMac,
  ITERACIONES_ENORMES,
  p12DePrueba,
} from './p12-de-prueba.test';

// node-forge abre y cifra .p12 en JS puro: con la máquina cargada (la suite
// completa en paralelo) un test pasa de los 5 s por defecto sin estar colgado.
vi.setConfig({ testTimeout: 30_000 });

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
  const emisor = { base: '900123456', dv: '8' };
  it('la base igual, con su DV tras guion o pegado si es el DV conocido', () => {
    expect(nitCoincide({ base: '900123456' }, emisor)).toBe(true);
    expect(nitCoincide({ base: '900123456', dv: '8' }, emisor)).toBe(true);
    expect(nitCoincide({ base: '9001234568' }, emisor)).toBe(true);
  });
  it('otro DV, otra base o un DV pegado sin DV conocido no pasan', () => {
    expect(nitCoincide({ base: '900123456', dv: '1' }, emisor)).toBe(false);
    expect(nitCoincide({ base: '9001234561' }, emisor)).toBe(false);
    expect(nitCoincide({ base: '800123456' }, emisor)).toBe(false);
    expect(nitCoincide({ base: '9001234568' }, { base: '900123456' })).toBe(false);
    expect(nitCoincide({ base: '' }, emisor)).toBe(false);
  });
  it('el NIT de 8 dígitos 90012345-6 no pasa por 900123456', () => {
    expect(nitCoincide({ base: '90012345', dv: '6' }, emisor)).toBe(false);
    const p12 = p12DePrueba({ nit: '90012345-6' });
    expect(motivo(() => validarCertificadoP12(p12, PASS, emisor))).toBe('nit');
    expect(motivo(() => validarCertificadoP12(p12, PASS, { base: '900123456' }))).toBe('nit');
  });
});

describe('nitDelEmisor', () => {
  it('toma el DV de nitDv o del guion del NIT', () => {
    expect(nitDelEmisor({ nitNorm: '900123456', nitDv: '8' })).toEqual({ base: '900123456', dv: '8' });
    expect(nitDelEmisor({ nitNorm: '900123456', nit: '900.123.456-8' })).toEqual({ base: '900123456', dv: '8' });
    expect(nitDelEmisor({ nitNorm: '900123456', nit: '900123456' })).toEqual({ base: '900123456' });
  });
});

describe('prioridad del NIT de empresa', () => {
  // Certificado de la empresa 900999888 con la cédula del representante legal
  // en el campo de persona de Certicámara y en el CN.
  const sujeto = [
    { name: 'commonName', value: 'ANA PEREZ 1020304050' },
    { type: '1.3.6.1.4.1.23267.2.2', value: '1020304050' },
    { type: '1.3.6.1.4.1.23267.2.3', value: '900999888' },
  ];
  it('la cédula del representante no pasa para un emisor persona natural', () => {
    const p12 = p12DePrueba({ sujeto });
    expect(motivo(() => validarCertificadoP12(p12, PASS, { base: '1020304050' }))).toBe('nit');
    expect(() => validarCertificadoP12(p12, PASS, { base: '900999888' })).not.toThrow();
  });
  it('sin campo de empresa, un certificado de persona natural sí pasa por su documento', () => {
    const p12 = p12DePrueba({
      sujeto: [
        { name: 'commonName', value: 'ANA PEREZ' },
        { type: '1.3.6.1.4.1.23267.2.2', value: '1020304050' },
      ],
    });
    expect(() => validarCertificadoP12(p12, PASS, { base: '1020304050' })).not.toThrow();
  });
});

describe('topes contra DoS (antes de usar la contraseña)', () => {
  const rapido = (fn: () => unknown) => {
    const t0 = Date.now();
    const m = motivo(fn);
    expect(Date.now() - t0).toBeLessThan(2000);
    return m;
  };

  it('el tope es de 100.000 iteraciones y 10 certificados', () => {
    expect(MAX_ITERACIONES_P12).toBe(100_000);
    expect(MAX_CERT_BAGS_P12).toBe(10);
  });

  it('rechaza un MAC con 2^31 iteraciones sin derivar la llave', () => {
    const p12 = conIteracionesMac(p12DePrueba(), ITERACIONES_ENORMES);
    expect(rapido(() => validarCertificadoP12(p12, PASS, NIT))).toBe('iteraciones');
    expect(rapido(() => validarCertificadoP12(p12, 'mala', NIT))).toBe('iteraciones');
  });

  it('rechaza un MAC con 100.001 iteraciones', () => {
    const p12 = conIteracionesMac(p12DePrueba(), MAX_ITERACIONES_P12 + 1);
    expect(rapido(() => validarCertificadoP12(p12, PASS, NIT))).toBe('iteraciones');
  });

  it('rechaza la llave privada cifrada con 2^31 iteraciones', () => {
    const p12 = conIteracionesLlave(p12DePrueba(), ITERACIONES_ENORMES);
    expect(rapido(() => validarCertificadoP12(p12, PASS, NIT))).toBe('iteraciones');
  });

  it.each(['3des', 'aes128'] as const)('rechaza el contenido cifrado (%s) con 2^31 iteraciones', (alg) => {
    const p12 = conIteracionesContenido(conCertsCifrados(p12DePrueba(), PASS, alg), ITERACIONES_ENORMES);
    expect(rapido(() => validarCertificadoP12(p12, PASS, NIT))).toBe('iteraciones');
  });

  it('un .p12 con los certificados cifrados (como OpenSSL) sí abre', () => {
    for (const alg of ['3des', 'aes128'] as const) {
      expect(() => validarCertificadoP12(conCertsCifrados(p12DePrueba(), PASS, alg), PASS, NIT)).not.toThrow();
    }
    expect(motivo(() => validarCertificadoP12(conCertsCifrados(p12DePrueba(), PASS), 'mala', NIT))).toBe(
      'password',
    );
  });

  it('16 EncryptedData de 100.000 iteraciones: rechazo rápido, sin derivar', () => {
    const base = conIteracionesContenido(conCertsCifrados(p12DePrueba(), PASS), MAX_ITERACIONES_P12);
    const p12 = conMac(conContenidosRepetidos(base, 16), PASS, 2048);
    const generar = vi.spyOn(forge.pkcs12, 'generateKey');
    try {
      expect(rapido(() => validarCertificadoP12(p12, PASS, NIT))).toBe('formato');
      expect(generar).not.toHaveBeenCalled();
    } finally {
      generar.mockRestore();
    }
  });

  it('4 contenidos de 100.000 pasan del presupuesto total (300.000) sin derivar', () => {
    expect(PRESUPUESTO_ITERACIONES_P12).toBeLessThanOrEqual(300_000);
    expect(MAX_CONTENIDOS_P12).toBe(4);
    const base = conIteracionesContenido(conCertsCifrados(p12DePrueba(), PASS), MAX_ITERACIONES_P12);
    const p12 = conContenidosRepetidos(base, 3);
    const generar = vi.spyOn(forge.pkcs12, 'generateKey');
    try {
      expect(rapido(() => validarCertificadoP12(p12, PASS, NIT))).toBe('iteraciones');
      expect(generar).not.toHaveBeenCalled();
    } finally {
      generar.mockRestore();
    }
  });

  it('contraseña mala con muchos contenidos: una sola derivación (el MAC)', () => {
    const p12 = conMac(conContenidosRepetidos(conCertsCifrados(p12DePrueba(), PASS), 3), PASS);
    const generar = vi.spyOn(forge.pkcs12, 'generateKey');
    const pbe = (forge.pki as unknown as { pbe: { getCipher: (...a: unknown[]) => unknown } }).pbe;
    const descifrar = vi.spyOn(pbe, 'getCipher');
    try {
      expect(rapido(() => validarCertificadoP12(p12, 'mala', NIT))).toBe('password');
      expect(generar).toHaveBeenCalledTimes(1);
      expect(descifrar).not.toHaveBeenCalled();
    } finally {
      generar.mockRestore();
      descifrar.mockRestore();
    }
  });

  it.each([2048, 10_000])(
    'un .p12 típico (1 contenido cifrado, 1 llave, MAC) con %i iteraciones abre',
    (n) => {
      const p12 = conMac(conCertsCifrados(p12DePrueba({ iteraciones: n }), PASS, '3des', n), PASS, n);
      const pbe = (forge.pki as unknown as { pbe: { getCipher: (...a: unknown[]) => unknown } }).pbe;
      const descifrar = vi.spyOn(pbe, 'getCipher');
      try {
        expect(() => validarCertificadoP12(p12, PASS, NIT)).not.toThrow();
        // El EncryptedData se descifra una sola vez: forge lo recibe en claro.
        // La otra llamada es la llave privada cifrada.
        expect(descifrar).toHaveBeenCalledTimes(2);
      } finally {
        descifrar.mockRestore();
      }
      expect(motivo(() => validarCertificadoP12(p12, 'mala', NIT))).toBe('password');
    },
  );

  it('rechaza más de 10 certificados, en claro o cifrados', () => {
    // Titular + ECD + 9 copias = 11.
    const p12 = p12DePrueba({ certsExtra: 9 });
    expect(rapido(() => validarCertificadoP12(p12, PASS, NIT))).toBe('demasiados-certificados');
    expect(rapido(() => validarCertificadoP12(conCertsCifrados(p12, PASS), PASS, NIT))).toBe(
      'demasiados-certificados',
    );
    // 10 justos pasan.
    expect(() => validarCertificadoP12(p12DePrueba({ certsExtra: 8 }), PASS, NIT)).not.toThrow();
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
