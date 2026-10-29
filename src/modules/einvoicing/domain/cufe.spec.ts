import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  cadenaCude,
  cadenaCufe,
  calcularCude,
  calcularCudePos,
  calcularCufe,
  computeCufe,
  dianVerificationUrl,
  type DatosCodigoUnico,
} from './cufe';

/**
 * Vectores de conformidad copiados del anexo técnico FEV v1.9 (Res. 000165 de
 * 2023, Diario Oficial 52.567). Los hashes esperados son los PUBLICADOS por la
 * DIAN, no recalculados aquí.
 */

/** §11.1.2: «CUFE de una factura-e de venta». */
const ANEXO_FEV: DatosCodigoUnico & { claveTecnica: string } = {
  numero: '323200000129',
  fecha: '2019-01-16',
  hora: '10:53:10-05:00',
  valorBruto: 150000000,
  impuestos: { '01': 28500000, '04': 0, '03': 0 },
  valorTotal: 178500000,
  nitEmisor: '700085371',
  numAdquiriente: '800199436',
  claveTecnica: '693ff6f2a553c3646a063436fd4dd9ded0311471',
  tipoAmbiente: '1',
};

/** §11.1.4.1: CUDE con Software-PIN (documento tipo 03, ambiente 2, con ICA). */
const ANEXO_CUDE_PIN: DatosCodigoUnico & { softwarePin: string } = {
  numero: '8110007871',
  fecha: '2019-02-20',
  hora: '16:46:55-05:00',
  valorBruto: 23528,
  impuestos: { '01': 1900, '04': 0, '03': 828 },
  valorTotal: 26256,
  nitEmisor: '900373076',
  numAdquiriente: '8355990',
  softwarePin: '12345',
  tipoAmbiente: '2',
};

/** §11.1.4.3 (y anexo DE v1.0 §14.1.5): nota crédito. */
const ANEXO_NC: DatosCodigoUnico & { softwarePin: string } = {
  numero: '8110007871',
  fecha: '2019-01-12',
  hora: '07:00:00-05:00',
  valorBruto: 500000,
  impuestos: { '01': 95000, '04': 0, '03': 0 },
  valorTotal: 595000,
  nitEmisor: '900373076',
  numAdquiriente: '8355990',
  softwarePin: '12301',
  tipoAmbiente: '1',
};

/** §11.1.4.5: nota débito con INC solo. */
const ANEXO_ND: DatosCodigoUnico & { softwarePin: string } = {
  numero: 'ND1001',
  fecha: '2019-01-18',
  hora: '10:58:00-05:00',
  valorBruto: 3000000,
  impuestos: { '01': 0, '04': 240000, '03': 0 },
  valorTotal: 3240000,
  nitEmisor: '900197264',
  numAdquiriente: '10254102',
  softwarePin: '10201',
  tipoAmbiente: '2',
};

const sha384 = (s: string) => createHash('sha384').update(s, 'utf8').digest('hex');

describe('CUFE (anexo FEV 1.9, §11.1.2)', () => {
  it('reproduce la composición y el CUFE publicados en el anexo', () => {
    expect(cadenaCufe(ANEXO_FEV)).toBe(
      '3232000001292019-01-1610:53:10-05:001500000.0001285000.00040.00030.001785000.00' +
        '700085371800199436693ff6f2a553c3646a063436fd4dd9ded03114711',
    );
    expect(calcularCufe(ANEXO_FEV)).toBe(
      '8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4',
    );
  });

  it('los tres pares van siempre, en orden 01/04/03 y con 0.00 si no aplican', () => {
    const base = { ...ANEXO_FEV, valorBruto: 1000000 };
    const par = (iva: number, inc: number, ica: number, tot: number) =>
      cadenaCufe({ ...base, impuestos: { '01': iva, '04': inc, '03': ica }, valorTotal: tot });
    // IVA solo.
    expect(par(190000, 0, 0, 1190000)).toContain('10000.0001' + '1900.00' + '04' + '0.00' + '03' + '0.00' + '11900.00');
    // INC solo (restaurante): el impuesto va en el par 04, no en el 01.
    expect(par(0, 80000, 0, 1080000)).toContain('10000.0001' + '0.00' + '04' + '800.00' + '03' + '0.00' + '10800.00');
    // IVA + INC.
    expect(par(190000, 80000, 0, 1270000)).toContain('01' + '1900.00' + '04' + '800.00' + '03' + '0.00');
    // Exento / excluido: los tres en 0.00.
    expect(par(0, 0, 0, 1000000)).toContain('10000.0001' + '0.00' + '04' + '0.00' + '03' + '0.00' + '10000.00');
  });

  it('IVA solo, INC solo, IVA + INC y exento dan CUFE distintos', () => {
    const casos = [
      { '01': 190000, '04': 0, '03': 0 },
      { '01': 0, '04': 190000, '03': 0 },
      { '01': 110000, '04': 80000, '03': 0 },
      { '01': 0, '04': 0, '03': 0 },
    ];
    const hashes = casos.map((impuestos) => calcularCufe({ ...ANEXO_FEV, impuestos }));
    expect(new Set(hashes).size).toBe(4);
  });

  it('el ambiente (1 vs 2) es parámetro y cambia el hash', () => {
    const prod = calcularCufe(ANEXO_FEV);
    const hab = calcularCufe({ ...ANEXO_FEV, tipoAmbiente: '2' });
    expect(hab).not.toBe(prod);
    expect(cadenaCufe({ ...ANEXO_FEV, tipoAmbiente: '2' }).endsWith('0311471' + '2')).toBe(true);
  });

  it('valida la entrada en lugar de calcular un código que la DIAN rechazaría', () => {
    expect(() => calcularCufe({ ...ANEXO_FEV, claveTecnica: ' ' })).toThrow(/clave técnica/);
    expect(() => calcularCufe({ ...ANEXO_FEV, nitEmisor: '700085371-1' })).toThrow(/sin puntos, guiones ni DV/);
    expect(() => calcularCufe({ ...ANEXO_FEV, tipoAmbiente: '3' as never })).toThrow(/ambiente/);
    expect(() => calcularCufe({ ...ANEXO_FEV, valorBruto: 1.5 })).toThrow(/centavos/);
    expect(() => calcularCufe({ ...ANEXO_FEV, fecha: '16/01/2019' })).toThrow(/Fecha inválida/);
    expect(() => calcularCufe({ ...ANEXO_FEV, hora: '10:53:10' })).toThrow(/Hora inválida/);
    expect(() => calcularCude({ ...ANEXO_NC, hora: '07:00:00-0500' })).toThrow(/Hora inválida/);
  });
});

describe('CUDE de notas (anexo FEV 1.9, §11.1.4): PIN del software, no clave técnica', () => {
  it('reproduce el CUDE publicado del ejemplo con Software-PIN (incluye ICA, ambiente 2)', () => {
    expect(cadenaCude(ANEXO_CUDE_PIN)).toBe(
      '81100078712019-02-2016:46:55-05:00235.280119.00040.00038.28262.56900373076835599012345' + '2',
    );
    expect(calcularCude(ANEXO_CUDE_PIN)).toBe(
      '955327eb55f8bdf16d069358a063d87e1577a292cb088ec186ed60bbc38e750b7b3980659b278ead789b95f9c51a9ef7',
    );
  });

  it('reproduce el CUDE publicado de la nota crédito', () => {
    expect(cadenaCude(ANEXO_NC)).toBe(
      '81100078712019-01-1207:00:00-05:005000.0001950.00040.00030.005950.009003730768355990123011',
    );
    expect(calcularCude(ANEXO_NC)).toBe(
      '907e4444decc9e59c160a2fb3b6659b33dc5b632a5008922b9a62f83f757b1c448e47f5867f2b50dbdb96f48c7681168',
    );
  });

  it('nota débito (INC solo): reproduce la composición publicada', () => {
    // El hash impreso en el anexo para este ejemplo (b9483dc2…) no sale de la
    // composición que el mismo anexo imprime; se fija la composición y el hash
    // se compara contra SHA-384 de ella, no contra el valor impreso.
    expect(cadenaCude(ANEXO_ND)).toBe(
      'ND10012019-01-1810:58:00-05:0030000.00010.00042400.00030.0032400.0090019726410254102102012',
    );
    expect(calcularCude(ANEXO_ND)).toBe(sha384(cadenaCude(ANEXO_ND)));
  });

  it('la llave es el PIN: con la clave técnica sale otro código', () => {
    const { softwarePin, ...datos } = ANEXO_NC;
    const conClave = calcularCufe({ ...datos, claveTecnica: '693ff6f2a553c3646a063436fd4dd9ded0311471' });
    expect(calcularCude(ANEXO_NC)).not.toBe(conClave);
    expect(cadenaCude(ANEXO_NC)).toContain(softwarePin + '1');
    expect(() => calcularCude({ ...ANEXO_NC, softwarePin: '' })).toThrow(/PIN del software/);
  });

  it('el ambiente cambia el CUDE', () => {
    expect(calcularCude({ ...ANEXO_NC, tipoAmbiente: '2' })).not.toBe(calcularCude(ANEXO_NC));
  });
});

describe('CUDE del documento equivalente POS (anexo DE v1.0, §14.1.2)', () => {
  it('misma composición que el CUDE con SfPin, y su ambiente también es parámetro', () => {
    const pos = { ...ANEXO_NC, numero: 'POS1', numAdquiriente: '222222222222' };
    expect(calcularCudePos(pos)).toBe(calcularCude(pos));
    expect(calcularCudePos({ ...pos, tipoAmbiente: '2' })).not.toBe(calcularCudePos(pos));
  });
});

describe('URL de verificación (QR) por ambiente (anexo FEV 1.9, §11.1.7.1)', () => {
  it('producción y habilitación apuntan a catálogos distintos', () => {
    expect(dianVerificationUrl('abc', '1')).toBe(
      'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=abc',
    );
    expect(dianVerificationUrl('abc', '2')).toBe(
      'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=abc',
    );
    // Sin ambiente: el por defecto del emisor (habilitación), coherente con el CUFE antiguo.
    expect(dianVerificationUrl('abc')).toBe(dianVerificationUrl('abc', '2'));
    expect(() => dianVerificationUrl('abc', '0' as never)).toThrow(/ambiente/);
  });
});

describe('computeCufe (firma antigua, solo mientras se conecta la nueva)', () => {
  it('equivale a calcularCufe con el impuesto como IVA, INC/ICA en 0 y ambiente 2', () => {
    const antiguo = computeCufe({
      numFac: '323200000129',
      fecFac: '2019-01-16',
      horFac: '10:53:10-05:00',
      valFac: 1500000,
      valIva: 285000,
      valTot: 1785000,
      nitOFE: '700085371',
      numAdq: '800199436',
      claveTecnica: ANEXO_FEV.claveTecnica,
    });
    expect(antiguo).toBe(calcularCufe({ ...ANEXO_FEV, tipoAmbiente: '2' }));
  });
});
