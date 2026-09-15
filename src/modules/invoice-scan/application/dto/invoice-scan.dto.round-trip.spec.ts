import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateInvoiceScanDto } from './invoice-scan.dto';

/**
 * Lo que la API devuelve tiene que poder volver a entrar.
 *
 * La pantalla de revisión guarda las `lineDecisions` tal como las recibió,
 * `matchedBy` incluido. El DTO no lo declaraba y el pipe global
 * (`forbidNonWhitelisted`) rechazaba el guardado con 400 —y con él "Aplicar",
 * que guarda antes de aplicar—. Pasó en producción con la primera factura.
 */
describe('UpdateInvoiceScanDto · ida y vuelta de las decisiones', () => {
  // Mismas opciones que el ValidationPipe global de main.ts.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: UpdateInvoiceScanDto });

  it('acepta las decisiones con el matchedBy que devolvió la API', async () => {
    const dto = await validate({
      lineDecisions: [
        { lineIndex: 0, target: 'inventory', createProduct: false, matchedBy: 'barcode' },
        { lineIndex: 1, target: 'inventory', createProduct: true, matchedBy: 'none' },
        { lineIndex: 2, target: 'ignore', createProduct: false, matchedBy: 'manual' },
      ],
    });

    expect(dto.lineDecisions.map((d: { matchedBy: string }) => d.matchedBy)).toEqual([
      'barcode',
      'none',
      'manual',
    ]);
  });

  it('acepta la ficha del producto nuevo con su presentación de compra', async () => {
    // Mismo riesgo que el `matchedBy`: la pantalla manda estos dos campos y sin
    // declararlos el pipe rechazaría con 400 el guardado —y con él "Aplicar"—.
    const dto = await validate({
      lineDecisions: [
        {
          lineIndex: 0,
          target: 'inventory',
          createProduct: true,
          inPurchaseUnits: true,
          newProduct: {
            sku: '10001',
            name: 'Harina de trigo',
            unit: 'g',
            purchaseUnit: 'bulto',
            purchaseFactor: 25000,
            reviewed: true,
          },
        },
      ],
    });

    expect(dto.lineDecisions[0].newProduct).toMatchObject({
      purchaseUnit: 'bulto',
      purchaseFactor: 25000,
    });
  });

  it('rechaza un matchedBy que no es de los conocidos', async () => {
    await expect(
      validate({
        lineDecisions: [{ lineIndex: 0, target: 'inventory', matchedBy: 'magia' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sigue rechazando campos que nadie declaró', async () => {
    await expect(
      validate({
        lineDecisions: [{ lineIndex: 0, target: 'inventory', inventado: true }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
