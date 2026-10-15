import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CheckoutLineDto } from './checkout-order.dto';

/**
 * La cuenta dividida reparte en milésimas (`evenShare`). Una cantidad con más
 * decimales deja restos por debajo del umbral que nadie cobra (ítem 1.11).
 */
describe('CheckoutLineDto · cantidad a cobrar', () => {
  const errores = (qty: number) =>
    validateSync(
      plainToInstance(CheckoutLineDto, {
        productId: '507f1f77bcf86cd799439011',
        qty,
      }),
    ).length;

  it('acepta hasta tres decimales', () => {
    expect(errores(0.334)).toBe(0);
    expect(errores(2)).toBe(0);
  });

  it('rechaza más de tres decimales', () => {
    expect(errores(0.3336)).toBeGreaterThan(0);
  });
});
