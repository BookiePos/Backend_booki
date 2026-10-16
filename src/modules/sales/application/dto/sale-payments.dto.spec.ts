import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateSaleDto } from './create-sale.dto';
import { CheckoutOrderDto } from './checkout-order.dto';

/**
 * Ítem 6.9: `payment` (un medio) o `payments` (cobro mixto). Sin ninguno de
 * los dos, o con `payments: null`, el `payment` se valida igual: si no, una
 * venta sin medio de pago llegaba al servicio.
 */
const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
const PROD = '68b0f3c2a1d4e5f6a7b8c9d1';
const errores = <T extends object>(clase: new () => T, datos: object) =>
  validateSync(plainToInstance(clase, datos)).map((e) => e.property);

const venta = (extra: object) => ({
  sedeId: SEDE,
  lines: [{ productId: PROD, qty: 1 }],
  ...extra,
});

describe('DTO de venta · medio de pago', () => {
  it('el payment único sigue valiendo', () => {
    expect(errores(CreateSaleDto, venta({ payment: { method: 'cash' } }))).toEqual([]);
  });

  it('el reparto vale sin payment', () => {
    expect(
      errores(
        CreateSaleDto,
        venta({
          payments: [
            { method: 'cash', amount: 1000 },
            { method: 'card', amount: 500 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('sin ninguno de los dos: falla payment', () => {
    expect(errores(CreateSaleDto, venta({}))).toEqual(['payment']);
  });

  it('payments: null no se salta la validación de payment', () => {
    expect(errores(CreateSaleDto, venta({ payments: null }))).toEqual(['payment']);
    expect(
      errores(CreateSaleDto, venta({ payments: null, payment: { method: 'nequi' } })),
    ).toEqual(['payment']);
    expect(
      errores(CreateSaleDto, venta({ payments: null, payment: { method: 'card' } })),
    ).toEqual([]);
  });

  it('una parte con medio desconocido o monto en cero no pasa', () => {
    expect(
      errores(CreateSaleDto, venta({ payments: [{ method: 'nequi', amount: 1 }] })),
    ).toEqual(['payments']);
    expect(
      errores(CreateSaleDto, venta({ payments: [{ method: 'cash', amount: 0 }] })),
    ).toEqual(['payments']);
  });

  it('checkout de cuenta: mismas reglas', () => {
    expect(errores(CheckoutOrderDto, {})).toEqual(['payment']);
    expect(errores(CheckoutOrderDto, { payments: null })).toEqual(['payment']);
    expect(errores(CheckoutOrderDto, { payment: { method: 'transfer' } })).toEqual([]);
    expect(
      errores(CheckoutOrderDto, { payments: [{ method: 'card', amount: 10 }] }),
    ).toEqual([]);
  });
});
