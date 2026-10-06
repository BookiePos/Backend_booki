import { describe, it, expect } from 'vitest';
import {
  buildTestInvoices,
  buildTestNote,
  summarizeTestSet,
  TEST_SET_COUNTS,
  type TestSetDoc,
} from './test-set';
import {
  interpretApidianResponse,
  toApidianDebitNote,
  toApidianInvoice,
} from './apidian-mapper';

/**
 * Set de pruebas de la DIAN (software propio): 8 facturas, 1 nota crédito y
 * 1 nota débito. Si sale mal, el negocio no se habilita; si se cuenta mal, el
 * asistente diría "listo" sin estarlo.
 */
describe('set de pruebas', () => {
  const issuer = {
    nit: '900123456',
    name: 'Empresa de prueba',
    departamento: 'Antioquia',
    ciudad: 'Medellín',
  };
  const invoices = buildTestInvoices(issuer, 990000001, '2026-10-06', '10:00:00');

  it('son 8 facturas con la numeración de pruebas de la DIAN, consecutivas', () => {
    expect(invoices).toHaveLength(TEST_SET_COUNTS.invoice);
    expect(invoices.map((i) => i.number)).toEqual([
      990000001, 990000002, 990000003, 990000004, 990000005, 990000006, 990000007, 990000008,
    ]);
    expect(new Set(invoices.map((i) => `${i.prefix}|${i.resolutionNumber}`))).toEqual(
      new Set(['SETP|18760000001']),
    );
  });

  it('cada factura cuadra: base + IVA = bruto − descuento', () => {
    for (const inv of invoices) {
      const json = toApidianInvoice(inv) as any;
      const t = json.legal_monetary_totals;
      const suma = json.tax_totals.reduce((s: number, x: any) => s + Number(x.tax_amount), 0);
      expect(Math.round((Number(t.line_extension_amount) + suma) * 100) / 100).toBe(
        Number(t.tax_inclusive_amount),
      );
    }
  });

  it('las notas referencian la factura por número, CUFE y fecha', () => {
    const cufe = 'c'.repeat(96);
    const nc = buildTestNote('credit_note', invoices[0]!, cufe, 1, '2026-10-06', '10:05:00');
    const nd = buildTestNote('debit_note', invoices[1]!, cufe, 1, '2026-10-06', '10:05:00');

    expect(nc).toMatchObject({ kind: 'credit_note', prefix: 'NC', number: 1 });
    expect(nc.reference).toEqual({ fullNumber: 'SETP990000001', cufe, issueDate: '2026-10-06' });
    expect(nd).toMatchObject({ kind: 'debit_note', prefix: 'ND' });
    expect(nd.reference?.fullNumber).toBe('SETP990000002');
  });

  it('la nota débito usa requested_monetary_totals y debit_note_lines', () => {
    const nd = buildTestNote('debit_note', invoices[1]!, 'c'.repeat(96), 1, '2026-10-06', '10:05:00');
    const json = toApidianDebitNote(nd) as any;

    expect(json.type_document_id).toBe(5);
    expect(json.requested_monetary_totals).toBeDefined();
    expect(json.legal_monetary_totals).toBeUndefined();
    expect(json.debit_note_lines).toHaveLength(1);
    expect(json.billing_reference.number).toBe('SETP990000002');
  });

  it('el envío al set devuelve una llave para consultar después', () => {
    const out = interpretApidianResponse(200, {
      cufe: 'c'.repeat(96),
      ResponseDian: {
        Envelope: {
          Body: {
            SendTestSetAsyncResponse: {
              SendTestSetAsyncResult: { ZipKey: 'b97308d9-968b-463a-a31a-94159a95e6ed' },
            },
          },
        },
      },
    });

    expect(out).toMatchObject({
      status: 'pending',
      zipKey: 'b97308d9-968b-463a-a31a-94159a95e6ed',
      cufe: 'c'.repeat(96),
    });
  });

  it('la consulta del zip trae el veredicto', () => {
    const out = interpretApidianResponse(200, {
      ResponseDian: {
        Envelope: {
          Body: {
            GetStatusZipResponse: {
              GetStatusZipResult: {
                DianResponse: { IsValid: 'true', XmlDocumentKey: 'k'.repeat(96), ErrorMessage: {} },
              },
            },
          },
        },
      },
    });

    expect(out).toMatchObject({ status: 'accepted', cufe: 'k'.repeat(96), errors: [] });
  });

  describe('resumen', () => {
    const doc = (kind: TestSetDoc['kind'], status: TestSetDoc['status']): TestSetDoc => ({
      kind,
      prefix: 'X',
      number: 1,
      status,
      errors: [],
    });

    it('completo solo con 8 facturas, 1 crédito y 1 débito aceptadas', () => {
      const docs = [
        ...Array.from({ length: 8 }, () => doc('invoice', 'accepted')),
        doc('credit_note', 'accepted'),
        doc('debit_note', 'accepted'),
      ];

      expect(summarizeTestSet(docs)).toMatchObject({ accepted: 10, complete: true });
    });

    it('una rechazada no cuenta: dice qué falta', () => {
      const docs = [
        ...Array.from({ length: 8 }, () => doc('invoice', 'accepted')),
        doc('credit_note', 'rejected'),
        doc('debit_note', 'pending'),
      ];

      expect(summarizeTestSet(docs)).toMatchObject({
        complete: false,
        rejected: 1,
        pending: 1,
        missing: { invoice: 0, credit_note: 1, debit_note: 1 },
      });
    });
  });
});
