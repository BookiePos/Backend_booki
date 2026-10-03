/**
 * Impuesto del domicilio.
 *
 * El cobro del domicilio hace parte del precio de la venta y, por tanto, de la
 * base gravable: la DIAN lo dijo para el impuesto al consumo (Oficio 664
 * [904106] del 23-05-2022, art. 512-9 E.T.: "el valor del domicilio […] hace
 * parte del precio total de consumo") y es la misma regla del IVA, cuya base
 * incluye los acarreos y demás erogaciones complementarias de la venta
 * (art. 447 E.T.).
 *
 * Como accesorio de la venta, el domicilio sigue la tarifa de lo que lleva. Si
 * el pedido mezcla tarifas (una gaseosa al 19 % y un pan excluido), el cobro se
 * reparte entre ellas en proporción al valor neto de cada una, y cada parte se
 * discrimina con su tarifa. En la factura electrónica eso sale como una línea
 * de domicilio por tarifa.
 *
 * El valor del domicilio, como todos los precios del POS, YA incluye el
 * impuesto: el cliente paga lo mismo que antes; lo que cambia es que ahora se
 * discrimina base + impuesto en vez de declararlo todo como ingreso exento.
 *
 * Dominio puro: sin Nest ni Mongoose.
 */

/** Lo mínimo de una línea de venta para repartir el domicilio. */
export interface DeliveryTaxLine {
  /** Valor neto de la línea (con impuesto incluido, tras descuentos). */
  net: number;
  /** Tarifa del impuesto de la línea, en porcentaje (0, 5, 19…). */
  rate: number;
}

/** La porción del domicilio que corresponde a una tarifa. */
export interface DeliveryTaxPart {
  rate: number;
  /** Porción del cobro del domicilio, impuesto incluido. */
  gross: number;
  /** Base gravable de la porción. */
  base: number;
  /** Impuesto de la porción. */
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Reparte el cobro del domicilio entre las tarifas de la venta.
 *
 * Las porciones suman EXACTAMENTE el cobro (al centavo): el residuo del
 * redondeo se lo queda la porción más grande, para que la factura cuadre con
 * lo que pagó el cliente. Si la venta no tiene valor neto (todo con descuento
 * total), el domicilio va completo a la tarifa más alta presente, o a 0 % si no
 * hay líneas.
 */
export function splitDeliveryTax(
  fee: number,
  lines: readonly DeliveryTaxLine[],
): DeliveryTaxPart[] {
  const total = round2(fee);
  if (total <= 0) return [];

  // Valor neto por tarifa.
  const byRate = new Map<number, number>();
  for (const l of lines) {
    const rate = Math.max(0, l.rate || 0);
    byRate.set(rate, (byRate.get(rate) ?? 0) + Math.max(0, l.net || 0));
  }
  const netSum = [...byRate.values()].reduce((a, b) => a + b, 0);

  let grossByRate: [number, number][];
  if (netSum <= 0) {
    const rates = [...byRate.keys()];
    const rate = rates.length ? Math.max(...rates) : 0;
    grossByRate = [[rate, total]];
  } else {
    grossByRate = [...byRate.entries()]
      .filter(([, net]) => net > 0)
      .map(([rate, net]) => [rate, round2((total * net) / netSum)]);
    // El residuo del redondeo va a la porción más grande.
    const assigned = round2(grossByRate.reduce((a, [, g]) => a + g, 0));
    const residue = round2(total - assigned);
    const biggest = grossByRate.reduce<[number, number] | undefined>(
      (max, part) => (!max || part[1] > max[1] ? part : max),
      undefined,
    );
    if (residue !== 0 && biggest) biggest[1] = round2(biggest[1] + residue);
  }

  return grossByRate
    .sort((a, b) => b[0] - a[0])
    .map(([rate, gross]) => {
      const base = rate > 0 ? round2(gross / (1 + rate / 100)) : gross;
      return { rate, gross, base, amount: round2(gross - base) };
    });
}
