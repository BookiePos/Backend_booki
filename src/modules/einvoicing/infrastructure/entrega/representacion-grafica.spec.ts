import { inflateSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import {
  datosRepresentacionDe,
  generarRepresentacionGrafica,
  LEYENDA_REPRESENTACION,
  type DocumentoParaPdf,
} from './representacion-grafica';

const CUFE = '8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4';

/**
 * Texto de un PDF de pdfkit: se inflan los flujos y se juntan las cadenas
 * hexadecimales de cada `TJ` (las fuentes estándar se escriben en WinAnsi).
 */
function textoPdf(pdf: Buffer): string {
  const crudo = pdf.toString('latin1');
  const partes: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(crudo); m; m = re.exec(crudo)) {
    let contenido: string;
    try {
      contenido = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      contenido = m[1]!;
    }
    for (const tj of contenido.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const linea = [...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)]
        .map((h) => Buffer.from(h[1]!, 'hex').toString('latin1'))
        .join('');
      partes.push(linea);
    }
  }
  return partes.join('\n');
}

const DOC: DocumentoParaPdf = {
  type: 'invoice',
  fullNumber: 'SETP990000001',
  issueDate: '2026-10-30',
  issueTime: '15:04:05-05:00',
  cufe: CUFE,
  tipoAmbiente: '2',
  qrUrl: `https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${CUFE}`,
  emisor: {
    name: 'Crunchy Munch SAS',
    nit: '900123456',
    nitDv: '7',
    address: 'Cra 1 # 2-3',
    ciudad: 'Medellín',
    departamento: 'Antioquia',
    phone: '3001234567',
    email: 'facturas@crunchy.co',
    responsabilidadFiscal: 'R-99-PN',
  },
  adquiriente: {
    docType: '13',
    docNumber: '1020304050',
    name: 'Ana Pérez',
    email: 'ana@correo.co',
    address: 'Calle 10',
  },
  lines: [
    {
      code: 'HAMB-1',
      description: 'Hamburguesa doble',
      qty: 2,
      unitCode: '94',
      unitPrice: 25_000,
      discountAmount: 0,
      base: 50_000,
      ivaRate: 0,
      ivaAmount: 0,
      taxScheme: '04',
      taxRate: 8,
      taxAmount: 4_000,
      total: 54_000,
    },
    {
      code: 'BOLSA',
      description: 'Bolsa plástica',
      qty: 1,
      unitCode: '94',
      unitPrice: 0,
      discountAmount: 0,
      base: 0,
      ivaRate: 0,
      ivaAmount: 0,
      perUnitTax: { codigo: '22', unidades: 1, valorUnitario: 70, valor: 70 },
      total: 70,
    },
  ],
  taxableBase: 50_000,
  ivaTotal: 0,
  incTotal: 4_000,
  bagTaxTotal: 70,
  discountTotal: 0,
  charges: [{ chargeIndicator: true, reason: 'Propina voluntaria', amount: 5_000 }],
  chargeTotal: 5_000,
  payableAmount: 59_070,
  total: 59_070,
  formaPago: '1',
  medioPago: '10',
  resolution: {
    numero: '18760000001',
    prefijo: 'SETP',
    rangoDesde: 990000000,
    rangoHasta: 995000000,
    vigenciaDesde: new Date('2019-01-19T00:00:00Z'),
    vigenciaHasta: new Date('2030-01-19T00:00:00Z'),
  },
  respuestaDian: { recibidaAt: '2026-10-30T20:15:00.000Z' },
};

describe('representación gráfica de la factura (PDF)', () => {
  it('es un PDF con CUFE, resolución completa, totales por tributo, propina y leyenda', async () => {
    const pdf = await generarRepresentacionGrafica(datosRepresentacionDe(DOC));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const texto = textoPdf(pdf);
    const plano = texto.replace(/\s+/g, '');

    expect(plano).toContain(CUFE);
    expect(texto).toContain('SETP990000001');
    // Resolución: número, fechas, rango y prefijo.
    expect(texto).toContain('18760000001');
    expect(texto).toContain('2019-01-19');
    expect(texto).toContain('2030-01-19');
    expect(texto).toMatch(/SETP\s*990000000/);
    expect(texto).toMatch(/SETP\s*995000000/);
    // Emisor, adquiriente y líneas.
    expect(texto).toContain('Crunchy Munch SAS');
    expect(texto).toContain('900123456-7');
    expect(texto).toContain('Ana Pérez');
    expect(texto).toContain('1020304050');
    expect(texto).toContain('Hamburguesa doble');
    // Tributos, propina y total.
    expect(texto).toContain('INC 8%');
    expect(texto).toContain('INC bolsas');
    expect(texto).toContain('Propina voluntaria');
    expect(texto).toMatch(/59\.070/);
    expect(plano).toContain(LEYENDA_REPRESENTACION.replace(/\s+/g, ''));
    expect(texto).toContain('HABILITACIÓN');
  });

  it('dibuja el QR (muchos rectángulos rellenos en la página)', async () => {
    const pdf = await generarRepresentacionGrafica(datosRepresentacionDe(DOC));
    const crudo = pdf.toString('latin1');
    const flujos = [...crudo.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map((m) => {
      try {
        return inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
      } catch {
        return '';
      }
    });
    const rects = flujos.join('\n').match(/ re\b/g)?.length ?? 0;
    expect(rects).toBeGreaterThan(200);
  });

  it('el QR usa la URL guardada; sin ella, la arma con el CUFE y el ambiente', () => {
    expect(datosRepresentacionDe(DOC).qr).toBe(DOC.qrUrl);
    const sin = datosRepresentacionDe({ ...DOC, qrUrl: undefined, tipoAmbiente: '1' });
    expect(sin.qr).toBe(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${CUFE}`);
  });

  it('un documento sin CUFE no tiene representación gráfica', () => {
    expect(() => datosRepresentacionDe({ ...DOC, cufe: undefined })).toThrow();
  });

  it('documento viejo (sin totales por tributo): muestra el IVA guardado sin inventar INC', async () => {
    const viejo: DocumentoParaPdf = {
      ...DOC,
      incTotal: undefined,
      bagTaxTotal: undefined,
      charges: undefined,
      chargeTotal: undefined,
      payableAmount: undefined,
      ivaTotal: 9_500,
      total: 59_500,
      lines: [{ ...DOC.lines[0]!, taxScheme: undefined, taxRate: undefined, taxAmount: undefined, ivaRate: 19, ivaAmount: 9_500, total: 59_500 }],
    };
    const texto = textoPdf(await generarRepresentacionGrafica(datosRepresentacionDe(viejo)));
    expect(texto).toContain('IVA 19%');
    expect(texto).not.toContain('INC bolsas');
    expect(texto).toMatch(/59\.500/);
  });
});
