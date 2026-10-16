import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { OpenCajaDto } from './open-caja.dto';
import { CloseCajaDto } from './close-caja.dto';
import { CajaMovementDto } from './caja-movement.dto';

/**
 * Ítem 5.2: la entrada de caja. Una base, un conteo o un movimiento negativo
 * descuadraría el turno a propósito o por error de digitación: el
 * ValidationPipe global lo rechaza antes de llegar al servicio.
 */
const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
const errores = <T extends object>(clase: new () => T, datos: object) =>
  validateSync(plainToInstance(clase, datos)).map((e) => e.property);

describe('DTO de caja', () => {
  it('apertura: base desde cero, nunca negativa', () => {
    expect(errores(OpenCajaDto, { sedeId: SEDE, openingAmount: 0 })).toEqual([]);
    expect(errores(OpenCajaDto, { sedeId: SEDE, openingAmount: -1 })).toEqual(['openingAmount']);
    expect(errores(OpenCajaDto, { sedeId: 'x', openingAmount: 1 })).toEqual(['sedeId']);
  });

  it('cierre: el conteo no puede ser negativo', () => {
    expect(errores(CloseCajaDto, { sedeId: SEDE, countedAmount: 1000, note: 'ok' })).toEqual([]);
    expect(errores(CloseCajaDto, { sedeId: SEDE, countedAmount: -5 })).toEqual(['countedAmount']);
    expect(errores(CloseCajaDto, { sedeId: SEDE, countedAmount: 0, countedBills: -1 })).toEqual([
      'countedBills',
    ]);
  });

  it('movimiento: monto positivo y tipo conocido', () => {
    expect(errores(CajaMovementDto, { sedeId: SEDE, type: 'out', amount: 500 })).toEqual([]);
    expect(errores(CajaMovementDto, { sedeId: SEDE, type: 'out', amount: 0 })).toEqual(['amount']);
    expect(errores(CajaMovementDto, { sedeId: SEDE, type: 'robo', amount: 5 })).toEqual(['type']);
  });
});
