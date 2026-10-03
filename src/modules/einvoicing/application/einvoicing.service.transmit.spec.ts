import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { EinvoicingService } from './einvoicing.service';
import type { SendOutcome } from '../domain/send-outcome';

/**
 * Emisión real ante la DIAN.
 *
 * Lo que no puede pasar, en orden de gravedad:
 * 1. Gastar un número autorizado en una factura que no podía salir (sin
 *    conexión, sin datos del cliente).
 * 2. Dar por buena una factura que la DIAN rechazó.
 * 3. Reenviar con número NUEVO una factura que en realidad ya había entrado.
 * 4. Bloquear la venta porque la DIAN está caída.
 *
 * Constructor: (model, counters, sales, sedes, businesses, accounts).
 */
describe('EinvoicingService · envío a la DIAN', () => {
  const sedeId = new Types.ObjectId();
  const saleId = new Types.ObjectId();
  const user = {
    userId: 'u1',
    email: 'cajera@bookipos.local',
    sedeIds: [sedeId.toString()],
    permissions: [],
  } as any;

  /** Lo que guarda `model.create`, con un `save` que no hace nada. */
  let guardado: any;
  let counters: any;
  let provider: any;
  let accounts: any;
  let service: EinvoicingService;
  let venta: any;
  let facturas: Record<string, any>;

  function sede(over: Record<string, unknown> = {}) {
    return {
      _id: sedeId,
      id: sedeId.toString(),
      code: 'S1',
      name: 'Centro',
      businessName: 'Arepas La 33 SAS',
      nit: '900123456',
      nitDv: '8',
      address: 'Calle 33',
      phone: '6044445566',
      emailFacturacion: 'f@arepas.co',
      departamento: 'Antioquia',
      ciudad: 'Medellín',
      resolucionFe: {
        numero: '18760000001',
        prefijo: 'SETP',
        rangoDesde: 990000000,
        rangoHasta: 995000000,
        claveTecnica: 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c',
      },
      ...over,
    };
  }

  function respuesta(out: Partial<SendOutcome>): SendOutcome {
    return { status: 'accepted', message: '', errors: [], ...out };
  }

  function build(opts: { conectado?: boolean; sede?: any } = {}) {
    guardado = undefined;
    facturas = {};
    venta = {
      _id: saleId,
      sedeId,
      status: 'completed',
      lines: [
        {
          sku: 'A1',
          name: 'Arepa',
          qty: 1,
          unitPrice: 11_900,
          discountAmount: 0,
          ivaRate: 19,
          taxBase: 10_000,
          taxAmount: 1_900,
        },
      ],
      deliveryTaxes: [],
      taxableBase: 10_000,
      taxTotal: 1_900,
      discountTotal: 0,
      total: 11_900,
      tip: 0,
      deliveryFee: 0,
      payment: { method: 'cash' },
    };
    counters = {
      findOneAndUpdate: vi.fn(() => ({
        exec: () => Promise.resolve({ seq: 1 }),
      })),
    };
    provider = {
      name: 'apidian',
      sendInvoice: vi.fn().mockResolvedValue(
        respuesta({ cufe: 'c'.repeat(96), qrUrl: 'https://qr', files: { pdf: 'F.pdf' } }),
      ),
      sendCreditNote: vi.fn().mockResolvedValue(respuesta({ cufe: 'n'.repeat(96) })),
      getStatus: vi.fn(),
    };
    accounts = {
      connectionFor: vi.fn().mockResolvedValue(
        opts.conectado === false
          ? undefined
          : { provider, token: 'tok', environment: 'produccion' },
      ),
    };
    const model = {
      findOne: vi.fn((q: any) => ({
        exec: () =>
          Promise.resolve(
            q.referenceId ? undefined : q.saleId ? undefined : undefined,
          ),
      })),
      findById: vi.fn((id: string) => ({
        exec: () => Promise.resolve(facturas[id]),
      })),
      create: vi.fn((doc: any) => {
        guardado = { ...doc, _id: new Types.ObjectId(), attempts: 0, save: vi.fn() };
        return Promise.resolve(guardado);
      }),
      find: vi.fn(),
    };
    service = new EinvoicingService(
      model as never,
      counters as never,
      { getOrFail: vi.fn().mockResolvedValue(venta) } as never,
      { findOrFail: vi.fn().mockResolvedValue(opts.sede ?? sede()) } as never,
      { consumeDocument: vi.fn() } as never,
      accounts as never,
    );
    return model;
  }

  beforeEach(() => vi.clearAllMocks());

  describe('antes de gastar un número', () => {
    it('sin conexión con la DIAN no reserva consecutivo', async () => {
      build({ conectado: false });

      await expect(service.createFromSale(saleId.toString(), user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('cliente identificado sin dirección: lo dice y no reserva consecutivo', async () => {
      build();
      venta.customer = { name: 'Ana', idNumber: '1020304050', phone: '3001234567' };

      await expect(service.createFromSale(saleId.toString(), user)).rejects.toThrow(
        /dirección/,
      );
      expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('sin clave técnica en la resolución tampoco', async () => {
      build({ sede: sede({ resolucionFe: { numero: '1', prefijo: 'X' } }) });

      await expect(service.createFromSale(saleId.toString(), user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('factura de una venta', () => {
    it('guarda el documento pendiente ANTES de enviarlo, con su número', async () => {
      const model = build();
      provider.sendInvoice.mockImplementation(async () => {
        // Al momento de enviar, el documento ya existe con su número.
        expect(model.create).toHaveBeenCalledOnce();
        expect(guardado.dianStatus).toBe('pending');
        return respuesta({ cufe: 'c'.repeat(96) });
      });

      const doc = await service.createFromSale(saleId.toString(), user);

      expect(doc.fullNumber).toBe('SETP990000000');
    });

    it('aceptada: guarda CUFE oficial, QR y archivo', async () => {
      build();

      const doc = await service.createFromSale(saleId.toString(), user);

      expect(doc).toMatchObject({
        dianStatus: 'accepted',
        cufe: 'c'.repeat(96),
        qrUrl: 'https://qr',
        pdfFile: 'F.pdf',
        attempts: 1,
      });
      expect(doc.nextAttemptAt).toBeUndefined();
    });

    it('le pasa al proveedor el token de la empresa', async () => {
      build();

      await service.createFromSale(saleId.toString(), user);

      expect(provider.sendInvoice.mock.calls[0][0]).toBe('tok');
    });

    it('rechazada: queda rechazada con las reglas, sin reintento automático', async () => {
      build();
      provider.sendInvoice.mockResolvedValue(
        respuesta({ status: 'rejected', message: 'Rechazada', errors: ['Regla: FAD06'] }),
      );

      const doc = await service.createFromSale(saleId.toString(), user);

      expect(doc.dianStatus).toBe('rejected');
      expect(doc.dianErrors).toEqual(['Regla: FAD06']);
      expect(doc.nextAttemptAt).toBeUndefined();
    });

    it('DIAN caída: la venta no se bloquea, la factura queda pendiente con reintento', async () => {
      build();
      provider.sendInvoice.mockResolvedValue(respuesta({ status: 'pending' }));

      const doc = await service.createFromSale(saleId.toString(), user);

      expect(doc.dianStatus).toBe('pending');
      expect(doc.nextAttemptAt).toBeInstanceOf(Date);
    });

    it('si el proveedor revienta, el documento queda fallido y no se pierde', async () => {
      build();
      provider.sendInvoice.mockRejectedValue(new Error('socket hang up'));

      const doc = await service.createFromSale(saleId.toString(), user);

      expect(doc.dianStatus).toBe('failed');
      expect(doc.dianMessage).toContain('socket hang up');
    });

    it('ya había entrado: consulta por CUFE en vez de reenviar con otro número', async () => {
      build();
      provider.sendInvoice.mockResolvedValue(
        respuesta({ status: 'duplicate', cufe: 'd'.repeat(96) }),
      );
      provider.getStatus.mockResolvedValue(respuesta({ cufe: 'd'.repeat(96) }));

      const doc = await service.createFromSale(saleId.toString(), user);

      expect(provider.getStatus).toHaveBeenCalledWith('tok', 'd'.repeat(96));
      expect(doc.dianStatus).toBe('accepted');
      expect(counters.findOneAndUpdate).toHaveBeenCalledOnce();
    });

    it('el domicilio sale como línea con su impuesto', async () => {
      build();
      venta.deliveryTaxes = [{ rate: 19, base: 5_000, amount: 950 }];
      venta.deliveryFee = 5_950;

      await service.createFromSale(saleId.toString(), user);

      const enviado = provider.sendInvoice.mock.calls[0][1];
      expect(enviado.lines).toHaveLength(2);
      expect(enviado.lines[1]).toMatchObject({
        code: 'DOMICILIO',
        base: 5_000,
        taxRate: 19,
        grossTotal: 5_950,
      });
      expect(guardado.total).toBe(17_850);
    });

    it('la propina viaja aparte de las líneas', async () => {
      build();
      venta.tip = 1_190;

      await service.createFromSale(saleId.toString(), user);

      expect(provider.sendInvoice.mock.calls[0][1].tip).toBe(1_190);
    });
  });

  describe('nota crédito', () => {
    it('solo sobre una factura que la DIAN aceptó', async () => {
      build();
      const id = new Types.ObjectId().toString();
      facturas[id] = {
        _id: id,
        type: 'invoice',
        sedeId,
        dianStatus: 'rejected',
      };

      await expect(service.createCreditNote(id, 'anular', user)).rejects.toThrow(
        /aceptó/,
      );
      expect(counters.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('referencia el CUFE y la fecha de la factura, con numeración del NIT', async () => {
      build();
      const id = new Types.ObjectId().toString();
      facturas[id] = {
        _id: id,
        type: 'invoice',
        sedeId,
        dianStatus: 'accepted',
        cufe: 'c'.repeat(96),
        fullNumber: 'SETP990000000',
        issueDate: '2026-10-01',
        emisor: { nit: '900123456' },
        lines: [],
        taxableBase: 10_000,
        ivaTotal: 1_900,
        total: 11_900,
      };

      const nota = await service.createCreditNote(id, 'Devolución total', user);

      expect(counters.findOneAndUpdate.mock.calls[0][0]._id).toBe('nc:nit:900123456');
      const enviado = provider.sendCreditNote.mock.calls[0][1];
      expect(enviado.reference).toEqual({
        fullNumber: 'SETP990000000',
        cufe: 'c'.repeat(96),
        issueDate: '2026-10-01',
      });
      expect(nota.dianStatus).toBe('accepted');
    });
  });
});
