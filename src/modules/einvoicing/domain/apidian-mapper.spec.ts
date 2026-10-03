import { describe, it, expect } from 'vitest';
import {
  interpretApidianResponse,
  missingCustomerData,
  nitCheckDigit,
  splitNit,
  toApidianCompany,
  toApidianCreditNote,
  toApidianInvoice,
} from './apidian-mapper';
import { findMunicipalityId } from './apidian-catalogs';
import type { EinvoiceDocument } from './einvoice-document';

/**
 * El traductor a APIDIAN es donde una factura se gana o se pierde ante la
 * DIAN: los totales tienen que cuadrar al centavo y el veredicto de la DIAN no
 * está donde parece (APIDIAN responde `success: true` aunque la rechacen).
 */

/** Una venta de mostrador: una arepa de $11.900 con IVA del 19 % incluido. */
function factura(over: Partial<EinvoiceDocument> = {}): EinvoiceDocument {
  return {
    kind: 'invoice',
    prefix: 'SETP',
    number: 990000001,
    resolutionNumber: '18760000001',
    issueDate: '2026-10-03',
    issueTime: '10:15:00',
    issuer: {
      nit: '900123456',
      dv: '8',
      name: 'Arepas La 33',
      address: 'Calle 33 #70-20',
      phone: '6044445566',
      email: 'facturas@arepas.co',
      departamento: 'Antioquia',
      ciudad: 'Medellín',
    },
    customer: {},
    lines: [
      {
        code: 'A1',
        description: 'Arepa',
        qty: 1,
        grossTotal: 11_900,
        base: 10_000,
        taxKind: 'iva',
        taxRate: 19,
        taxAmount: 1_900,
      },
    ],
    paymentMethod: 'cash',
    tip: 0,
    ...over,
  };
}

const num = (s: unknown) => Number(s);

describe('toApidianInvoice', () => {
  it('consumidor final: solo el NIT genérico, sin dirección ni teléfono', () => {
    const json = toApidianInvoice(factura()) as any;

    expect(json.customer).toEqual({
      identification_number: '222222222222',
      name: 'CONSUMIDOR FINAL',
      merchant_registration: '0000000-00',
    });
    expect(json.sendmail).toBe(false);
  });

  it('una línea con IVA: base, impuesto y totales cuadran', () => {
    const json = toApidianInvoice(factura()) as any;
    const [line] = json.invoice_lines;

    expect(line.price_amount).toBe('10000.00');
    expect(line.line_extension_amount).toBe('10000.00');
    expect(line.tax_totals).toEqual([
      { tax_id: 1, tax_amount: '1900.00', taxable_amount: '10000.00', percent: '19.00' },
    ]);
    expect(json.legal_monetary_totals).toEqual({
      line_extension_amount: '10000.00',
      tax_exclusive_amount: '10000.00',
      tax_inclusive_amount: '11900.00',
      allowance_total_amount: '0.00',
      charge_total_amount: '0.00',
      payable_amount: '11900.00',
    });
  });

  it('la base de cada línea es cantidad × precio − descuento, exacto', () => {
    // 3 arepas de 11.900 con 5.000 de descuento: neto 30.700 → base 25.798,32.
    const json = toApidianInvoice(
      factura({
        lines: [
          {
            code: 'A1',
            description: 'Arepa',
            qty: 3,
            grossTotal: 35_700,
            base: 25_798.32,
            taxKind: 'iva',
            taxRate: 19,
            taxAmount: 4_901.68,
          },
        ],
      }),
    ) as any;
    const [line] = json.invoice_lines;
    const descuento = num(line.allowance_charges[0].amount);

    expect(
      Math.round((num(line.price_amount) * 3 - descuento) * 100) / 100,
    ).toBe(num(line.line_extension_amount));
    expect(line.allowance_charges[0].charge_indicator).toBe(false);
  });

  it('el impuesto de cada línea es base × tarifa (lo que valida la DIAN)', () => {
    const json = toApidianInvoice(
      factura({
        lines: [
          {
            code: 'X',
            description: 'Gaseosa',
            qty: 7,
            grossTotal: 24_500,
            base: 20_588.24,
            taxKind: 'iva',
            taxRate: 19,
            taxAmount: 3_911.76,
          },
        ],
      }),
    ) as any;
    const t = json.invoice_lines[0].tax_totals[0];

    expect(num(t.tax_amount)).toBe(
      Math.round(num(t.taxable_amount) * 0.19 * 100) / 100,
    );
  });

  it('agrupa los totales de la cabecera por tributo y tarifa', () => {
    const json = toApidianInvoice(
      factura({
        lines: [
          { code: 'A', description: 'A', qty: 1, grossTotal: 11_900, base: 10_000, taxKind: 'iva', taxRate: 19, taxAmount: 1_900 },
          { code: 'B', description: 'B', qty: 1, grossTotal: 2_380, base: 2_000, taxKind: 'iva', taxRate: 19, taxAmount: 380 },
          { code: 'C', description: 'C', qty: 1, grossTotal: 1_050, base: 1_000, taxKind: 'iva', taxRate: 5, taxAmount: 50 },
        ],
      }),
    ) as any;

    expect(json.tax_totals).toEqual([
      { tax_id: 1, tax_amount: '2280.00', percent: '19.00', taxable_amount: '12000.00' },
      { tax_id: 1, tax_amount: '50.00', percent: '5.00', taxable_amount: '1000.00' },
    ]);
  });

  it('el impuesto al consumo va con su tributo (INC), no como IVA', () => {
    const json = toApidianInvoice(
      factura({
        lines: [
          { code: 'P', description: 'Plato', qty: 1, grossTotal: 10_800, base: 10_000, taxKind: 'inc', taxRate: 8, taxAmount: 800 },
        ],
      }),
    ) as any;

    expect(json.invoice_lines[0].tax_totals[0].tax_id).toBe(4);
    expect(json.tax_totals[0]).toMatchObject({ tax_id: 4, percent: '8.00' });
  });

  it('una línea excluida no lleva tributo ni suma a la base gravable', () => {
    const json = toApidianInvoice(
      factura({
        lines: [
          { code: 'A', description: 'A', qty: 1, grossTotal: 11_900, base: 10_000, taxKind: 'iva', taxRate: 19, taxAmount: 1_900 },
          { code: 'P', description: 'Pan', qty: 1, grossTotal: 3_000, base: 3_000, taxKind: 'none', taxRate: 0, taxAmount: 0 },
        ],
      }),
    ) as any;

    expect(json.invoice_lines[1].tax_totals).toBeUndefined();
    expect(json.legal_monetary_totals.line_extension_amount).toBe('13000.00');
    expect(json.legal_monetary_totals.tax_exclusive_amount).toBe('10000.00');
    expect(json.legal_monetary_totals.payable_amount).toBe('14900.00');
  });

  it('la propina va como cargo, fuera de la base, y sí se suma al pago', () => {
    const json = toApidianInvoice(factura({ tip: 1_190 })) as any;

    expect(json.allowance_charges).toEqual([
      expect.objectContaining({
        type_discount_id: 4,
        charge_indicator: true,
        amount: '1190.00',
      }),
    ]);
    expect(json.legal_monetary_totals.tax_inclusive_amount).toBe('11900.00');
    expect(json.legal_monetary_totals.charge_total_amount).toBe('1190.00');
    expect(json.legal_monetary_totals.payable_amount).toBe('13090.00');
  });

  it('cliente con NIT: calcula el DV y lo marca como persona jurídica', () => {
    const json = toApidianInvoice(
      factura({
        customer: {
          docType: '31',
          docNumber: '900166483',
          name: 'Inversiones Daval SAS',
          phone: '3103891693',
          address: 'Cll 4 33-90',
          email: 'compras@daval.co',
        },
      }),
    ) as any;

    expect(json.customer).toMatchObject({
      identification_number: '900166483',
      dv: '1',
      type_document_identification_id: 6,
      type_organization_id: 1,
      email: 'compras@daval.co',
    });
    expect(json.sendmail).toBe(true);
  });

  it('cliente con cédula: sin DV y como persona natural', () => {
    const json = toApidianInvoice(
      factura({
        customer: { docType: '13', docNumber: '1.020.304.050', name: 'Ana', phone: '3001234567', address: 'Cra 1' },
      }),
    ) as any;

    expect(json.customer.identification_number).toBe('1020304050');
    expect(json.customer.dv).toBeUndefined();
    expect(json.customer.type_document_identification_id).toBe(3);
    expect(json.customer.type_organization_id).toBe(2);
  });

  it('medios de pago: efectivo, tarjeta y transferencia con su código', () => {
    const metodo = (m: string) =>
      (toApidianInvoice(factura({ paymentMethod: m })) as any).payment_form;

    expect(metodo('cash').payment_method_id).toBe(10);
    expect(metodo('card').payment_method_id).toBe(48);
    expect(metodo('transfer').payment_method_id).toBe(47);
    expect(metodo('cash').payment_form_id).toBe(1);
  });

  it('el fiado va como venta a crédito, con fecha de vencimiento', () => {
    const pf = (toApidianInvoice(factura({ paymentMethod: 'credit' })) as any)
      .payment_form;

    expect(pf.payment_form_id).toBe(2);
    expect(pf.payment_due_date).toBe('2026-11-02');
  });

  it('lleva el municipio del establecimiento', () => {
    const json = toApidianInvoice(factura()) as any;

    expect(json.establishment_municipality).toBe(1); // Medellín
  });
});

describe('toApidianCreditNote', () => {
  it('referencia la factura por número, CUFE y fecha, como anulación', () => {
    const json = toApidianCreditNote(
      factura({
        kind: 'credit_note',
        prefix: 'NC',
        number: 7,
        reference: { fullNumber: 'SETP990000001', cufe: 'a'.repeat(96), issueDate: '2026-10-03' },
        reason: 'Cliente devolvió todo',
      }),
    ) as any;

    expect(json.type_document_id).toBe(4);
    expect(json.billing_reference).toEqual({
      number: 'SETP990000001',
      uuid: 'a'.repeat(96),
      issue_date: '2026-10-03',
    });
    expect(json.discrepancyresponsecode).toBe(2);
    expect(json.credit_note_lines).toHaveLength(1);
    expect(json.invoice_lines).toBeUndefined();
  });

  it('sin factura de referencia no se arma', () => {
    expect(() => toApidianCreditNote(factura({ kind: 'credit_note' }))).toThrow();
  });
});

describe('missingCustomerData', () => {
  it('el consumidor final no necesita nada', () => {
    expect(missingCustomerData({})).toEqual([]);
    expect(missingCustomerData({ docNumber: '222222222222' })).toEqual([]);
  });

  it('a un cliente identificado le pide dirección y teléfono', () => {
    expect(missingCustomerData({ docNumber: '123', name: 'Ana' })).toEqual([
      'dirección',
      'teléfono',
    ]);
  });
});

describe('NIT', () => {
  it('calcula el dígito de verificación de la DIAN', () => {
    expect(nitCheckDigit('900166483')).toBe('1');
    expect(nitCheckDigit('89008003')).toBe('2'); // el de los ejemplos de APIDIAN
    expect(nitCheckDigit('860034313')).toBe('7');
  });

  it('respeta el DV escrito y lo calcula si falta', () => {
    expect(splitNit('900166483-1')).toEqual({ number: '900166483', dv: '1' });
    expect(splitNit('900.166.483')).toEqual({ number: '900166483', dv: '1' });
  });
});

describe('findMunicipalityId', () => {
  it('encuentra la ciudad sin importar tildes ni mayúsculas', () => {
    expect(findMunicipalityId('Antioquia', 'MEDELLIN')).toBe(1);
    expect(findMunicipalityId(undefined, 'Bogotá')).toBe(149);
    expect(findMunicipalityId(undefined, 'Bogotá D.C.')).toBe(149);
  });

  it('acepta el código DANE', () => {
    expect(findMunicipalityId(undefined, '76001')).toBe(1006); // Cali
  });

  it('un nombre repetido sin departamento no adivina', () => {
    // "La Unión" existe en varios departamentos.
    expect(findMunicipalityId(undefined, 'La Unión')).toBeUndefined();
    expect(findMunicipalityId('Nariño', 'La Unión')).toBeTypeOf('number');
  });
});

describe('toApidianCompany', () => {
  const sede = {
    nit: '900123456',
    businessName: 'Arepas La 33 SAS',
    tipoPersona: 'juridica' as const,
    responsabilidadFiscal: 'responsable_iva' as const,
    address: 'Calle 33 #70-20',
    phone: '604 444 5566',
    email: 'facturas@arepas.co',
    departamento: 'Antioquia',
    ciudad: 'Medellín',
  };

  it('arma la empresa con NIT, DV y municipio', () => {
    const out = toApidianCompany(sede);

    expect(out.nit).toBe('900123456');
    expect(out.dv).toBe(nitCheckDigit('900123456'));
    expect(out.body).toMatchObject({
      type_organization_id: 1,
      type_regime_id: 1,
      municipality_id: 1,
      phone: '6044445566',
    });
  });

  it('dice exactamente qué dato fiscal falta', () => {
    expect(() => toApidianCompany({ ...sede, address: '', ciudad: 'Narnia' })).toThrow(
      /dirección.*departamento y ciudad/,
    );
  });
});

describe('interpretApidianResponse', () => {
  /** Respuesta de APIDIAN con el veredicto de la DIAN adentro. */
  function respuesta(result: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      success: true,
      cufe: 'c'.repeat(96),
      QRStr: 'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=ccc',
      urlinvoicepdf: 'FES-SETP990000001.pdf',
      urlinvoicexml: 'FES-SETP990000001.xml',
      certificate_days_left: '120',
      ResponseDian: {
        Envelope: { Body: { SendBillSyncResponse: { SendBillSyncResult: result } } },
      },
      ...extra,
    };
  }

  it('IsValid true: aceptada, con CUFE, QR y archivos', () => {
    const out = interpretApidianResponse(
      200,
      respuesta({ IsValid: 'true', StatusCode: '00', XmlDocumentKey: 'k'.repeat(96) }),
    );

    expect(out.status).toBe('accepted');
    expect(out.cufe).toBe('k'.repeat(96));
    expect(out.qrUrl).toContain('documentkey=');
    expect(out.files?.pdf).toBe('FES-SETP990000001.pdf');
    expect(out.certificateDaysLeft).toBe(120);
  });

  it('success true pero IsValid false: RECHAZADA, con las reglas', () => {
    const out = interpretApidianResponse(
      200,
      respuesta({
        IsValid: 'false',
        StatusCode: '99',
        StatusDescription: 'Validación contiene errores en campos mandatorios.',
        ErrorMessage: { string: ['Regla: FAD06, Rechazo: NIT del adquiriente no válido'] },
      }),
    );

    expect(out.status).toBe('rejected');
    expect(out.errors).toEqual(['Regla: FAD06, Rechazo: NIT del adquiriente no válido']);
  });

  it('regla 90 (procesado anteriormente) no es rechazo: es duplicado', () => {
    const out = interpretApidianResponse(
      200,
      respuesta({
        IsValid: 'false',
        ErrorMessage: { string: 'Regla: 90, Rechazo: Documento procesado anteriormente.' },
      }),
    );

    expect(out.status).toBe('duplicate');
    expect(out.cufe).toBe('c'.repeat(96));
  });

  it('"ya fue enviado anteriormente" de APIDIAN también es duplicado', () => {
    const out = interpretApidianResponse(200, {
      success: false,
      message: 'Este documento ya fue enviado anteriormente, se registra en la base de datos.',
      cufe: 'd'.repeat(96),
    });

    expect(out).toMatchObject({ status: 'duplicate', cufe: 'd'.repeat(96) });
  });

  it('DIAN caída: queda pendiente para reintentar', () => {
    const out = interpretApidianResponse(200, {
      success: false,
      message: 'El servicio de la DIAN no está disponible en este momento. Por favor, inténtelo más tarde.',
    });

    expect(out.status).toBe('pending');
  });

  it('sin respuesta (red o timeout) o error 5xx: pendiente', () => {
    expect(interpretApidianResponse(0, undefined).status).toBe('pending');
    expect(interpretApidianResponse(502, '<html>').status).toBe('pending');
  });

  it('datos inválidos (422): rechazada sin llegar a la DIAN, con los campos', () => {
    const out = interpretApidianResponse(422, {
      message: 'The given data was invalid.',
      errors: { 'customer.address': ['El campo es obligatorio.'] },
    });

    expect(out.status).toBe('rejected');
    expect(out.errors).toEqual(['customer.address: El campo es obligatorio.']);
  });

  it('token inválido o certificado vencido: falla de configuración', () => {
    expect(interpretApidianResponse(401, { message: 'Unauthenticated.' }).status).toBe('failed');
    expect(
      interpretApidianResponse(200, { success: false, message: 'El certificado se encuentra vencido.' })
        .status,
    ).toBe('failed');
  });

  it('lee también la respuesta de la consulta de estado', () => {
    const out = interpretApidianResponse(200, {
      success: true,
      ResponseDian: {
        Envelope: {
          Body: {
            GetStatusResponse: {
              GetStatusResult: { IsValid: 'true', XmlDocumentKey: 'e'.repeat(96) },
            },
          },
        },
      },
    });

    expect(out).toMatchObject({ status: 'accepted', cufe: 'e'.repeat(96) });
  });
});
