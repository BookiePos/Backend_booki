import type { Conteo } from './en-cada-empresa';
import { fechaColombia } from '../modules/core-ledger/domain/fecha-contable';
import { splitTaxIncluded } from '../modules/sales/domain/sale-amounts';
import { cop } from '../modules/finance/domain/money.util';

/**
 * Informe del domicilio que se cobró SIN impuesto antes de oct-2026.
 *
 * Hasta entonces el cobro de domicilio iba entero a ingresos (4135) y nada a la
 * 2495. Desde ese cambio lleva el mismo impuesto que la comida (arts. 512-1
 * num. 3 y 512-9 ET, Oficio DIAN 664 (904106) de 2022). Las ventas anteriores
 * NO se reescriben: el libro es inmutable y la corrección, si la hay, la decide
 * el contador (declaración de corrección del INC del bimestre). Este script
 * solo le da la cifra: cuántas ventas y cuánto domicilio sin impuesto hubo por
 * mes, y el INC del 8 % que llevaría si estuviera incluido (referencia: una
 * franquicia causa IVA y un no responsable, nada).
 *
 * Solo LEE: `aplicar` falla siempre.
 */

export interface VentaConDomicilio {
  deliveryFee?: number;
  deliveryTaxKind?: string;
  soldAt?: Date;
  createdAt: Date;
}

/** Tarifa de referencia: la del INC de restaurantes. */
const INC_REFERENCIA = 8;

/** Por mes (YYYY-MM): ventas, domicilio cobrado y el INC 8 % que llevaría incluido. */
export function contarDomicilioSinInc(ventas: readonly VentaConDomicilio[]): Conteo {
  const out: Conteo = {};
  for (const v of ventas) {
    const fee = cop(v.deliveryFee ?? 0);
    // Una venta con `deliveryTaxKind` ya se liquidó con la regla nueva.
    if (fee <= 0 || v.deliveryTaxKind) continue;
    const mes = fechaColombia(v.soldAt ?? v.createdAt).slice(0, 7);
    const inc = splitTaxIncluded(fee, INC_REFERENCIA).tax;
    out[`${mes}.ventas`] = (out[`${mes}.ventas`] ?? 0) + 1;
    out[`${mes}.domicilio`] = (out[`${mes}.domicilio`] ?? 0) + fee;
    out[`${mes}.inc8Incluido`] = (out[`${mes}.inc8Incluido`] ?? 0) + inc;
  }
  return out;
}

export function aplicarDomicilioSinInc(): Promise<never> {
  return Promise.reject(
    new Error(
      'Solo informe: el libro es inmutable y las ventas anteriores quedan como pasaron. ' +
        'Si hay que corregir el INC de esos bimestres, lo decide el contador.',
    ),
  );
}
