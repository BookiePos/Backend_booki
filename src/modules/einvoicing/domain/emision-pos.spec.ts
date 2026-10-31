import { describe, it, expect } from 'vitest';
import {
  cajaVentaPos,
  fabricanteDesdeEntorno,
  PUNTO_VENTA_POR_DEFECTO,
  pagosPos,
} from './emision-pos';

describe('cajaVentaPos', () => {
  it('sin puntos de venta configurados usa el valor por defecto con el código y la dirección de la sede', () => {
    const caja = cajaVentaPos(
      { code: 'centro', name: 'Sede Centro', address: 'Cra 1 # 2-3' },
      { saleNumber: 'FV-000010', cashierName: 'Ana', cashierEmail: 'ana@x.co' },
    );
    expect(caja).toEqual({
      placa: 'CENTRO',
      ubicacion: 'Cra 1 # 2-3',
      tipo: PUNTO_VENTA_POR_DEFECTO.tipo,
      cajero: 'Ana',
      codigoVenta: 'FV-000010',
    });
  });

  it('con puntos de venta toma el primero', () => {
    const caja = cajaVentaPos(
      {
        code: 'c',
        name: 'S',
        puntosVenta: [
          { placa: 'CAJA-01', ubicacion: 'Mostrador', tipo: 'Caja auxiliar' },
          { placa: 'CAJA-02', ubicacion: 'Terraza', tipo: 'Caja' },
        ],
      },
      { saleNumber: 'FV-1', cashierEmail: 'c@x.co' },
    );
    expect(caja.placa).toBe('CAJA-01');
    expect(caja.ubicacion).toBe('Mostrador');
    expect(caja.tipo).toBe('Caja auxiliar');
  });

  it('cajero: cashierName, luego el vendedor, luego el correo', () => {
    const sede = { code: 'c', name: 'S' };
    expect(cajaVentaPos(sede, { saleNumber: '1', seller: { name: 'Beto' }, cashierEmail: 'z@x.co' }).cajero).toBe('Beto');
    expect(cajaVentaPos(sede, { saleNumber: '1', cashierEmail: 'z@x.co' }).cajero).toBe('z@x.co');
  });

  it('sin dirección la ubicación es el nombre de la sede', () => {
    expect(cajaVentaPos({ code: 'c', name: 'Sede Norte' }, { saleNumber: '1', cashierEmail: 'a' }).ubicacion).toBe(
      'Sede Norte',
    );
  });
});

describe('fabricanteDesdeEntorno', () => {
  it('lee el fabricante del entorno', () => {
    expect(
      fabricanteDesdeEntorno({
        FE_FABRICANTE_NOMBRE: 'Samuel Múnera',
        FE_FABRICANTE_RAZON_SOCIAL: 'BookiPos SAS',
        FE_FABRICANTE_NIT: '901.234.567-8',
        FE_FABRICANTE_SOFTWARE: 'BookiPos POS',
      }),
    ).toEqual({
      nombreApellido: 'Samuel Múnera',
      razonSocial: 'BookiPos SAS',
      nit: '901234567',
      nombreSoftware: 'BookiPos POS',
    });
  });

  it('sin entorno: BookiPos como nombre y software, sin razón social ni NIT', () => {
    expect(fabricanteDesdeEntorno({})).toEqual({
      nombreApellido: 'BookiPos',
      nombreSoftware: 'BookiPos',
    });
  });
});

describe('pagosPos', () => {
  it('un solo medio: una parte por el total cobrado, de contado', () => {
    const pagos = pagosPos({
      total: 10000,
      tip: 1000,
      payment: { method: 'card', cardType: 'debit' },
    });
    expect(pagos).toEqual([{ metodo: 'card', monto: 11000, formaPago: '1', tipoTarjeta: 'debit' }]);
  });

  it('pago mixto: una parte por medio; el fiado es forma de pago 2', () => {
    const pagos = pagosPos({
      total: 30000,
      payment: { method: 'cash' },
      payments: [
        { method: 'cash', amount: 10000 },
        { method: 'transfer', amount: 5000, channel: 'nequi' },
        { method: 'credit', amount: 15000 },
      ],
    } as any);
    expect(pagos).toEqual([
      { metodo: 'cash', monto: 10000, formaPago: '1' },
      { metodo: 'transfer', monto: 5000, formaPago: '1', canal: 'nequi' },
      { metodo: 'credit', monto: 15000, formaPago: '2' },
    ]);
  });
});
