import { describe, expect, it } from 'vitest';
import { documentoDeVenta, type VentaParaDocumento } from './documento-venta';
import {
  cargosDeDevolucion,
  GRUPO_DOMICILIO,
  gruposDelDocumento,
  lineasDeAnulacion,
  lineasDeDevolucion,
  NotaNoRelacionableError,
  saldoAcreditable,
  TopeNotaExcedidoError,
  totalesDeNota,
  type LineaPedida,
} from './nota-de-venta';
import { buildReturnPlan } from '../../sales/domain/sale-return';
import { descuadresFactura } from './ubl/factura-ubl';

/**
 * Tope y líneas de la nota de la Fase 6B. La venta: 3 hamburguesas con INC 8 %
 * ($30.000), 2 gaseosas con IVA 19 % ($10.000), domicilio con INC ($5.000) y
 * propina ($3.000). Los valores pedidos salen del MISMO plan de devolución
 * que va al libro (`buildReturnPlan`), así la nota y el asiento coinciden.
 */
const HAMB = 'p-hamb';
const GAS = 'p-gas';

const venta: VentaParaDocumento = {
  lines: [
    { sku: 'H1', name: 'Hamburguesa', qty: 3, unitPrice: 10_000, lineTotal: 30_000, taxKind: 'inc', taxRate: 8, taxBase: 27_778, taxAmount: 2_222 },
    { sku: 'G1', name: 'Gaseosa', qty: 2, unitPrice: 5_000, lineTotal: 10_000, taxKind: 'iva', taxRate: 19, taxTreatment: 'gravado', taxBase: 8_403, taxAmount: 1_597 },
  ],
  total: 40_000,
  tip: 3_000,
  deliveryFee: 5_000,
  deliveryTaxKind: 'inc',
  deliveryTaxRate: 8,
  deliveryTaxBase: 4_630,
  deliveryTax: 370,
};
const doc = documentoDeVenta(venta);
const referidas = gruposDelDocumento(doc.lines, [HAMB, GAS], true);
const vendidas = [
  { productId: HAMB, qty: 3, taxBase: 27_778, taxAmount: 2_222 },
  { productId: GAS, qty: 2, taxBase: 8_403, taxAmount: 1_597 },
];

/** Las pedidas de una devolución, desde el plan real (con lo ya devuelto). */
function pedidas(
  req: { productId: string; qty: number }[],
  previo: Map<string, number> = new Map(),
  plata?: Map<string, { refund: number; refundTax: number }>,
): LineaPedida[] {
  const plan = buildReturnPlan(vendidas, req, previo, plata);
  return plan.lines.map((l) => ({ refKey: l.productId, qty: l.qty, valor: l.refund, impuesto: l.refundTax }));
}

describe('nota-de-venta · grupos del documento', () => {
  it('cada línea queda con su producto y el domicilio al final', () => {
    expect(referidas.map((l) => l.refKey)).toEqual([HAMB, GAS, GRUPO_DOMICILIO]);
  });

  it('si las líneas no corresponden a la venta, no adivina', () => {
    expect(() => gruposDelDocumento(doc.lines, [HAMB], true)).toThrow(NotaNoRelacionableError);
  });
});

describe('nota-de-venta · devolución parcial (concepto 1)', () => {
  it('con IVA e INC: cada línea lleva su tributo, la tarifa del documento y los valores del plan', () => {
    const lineas = lineasDeDevolucion(referidas, [], pedidas([{ productId: HAMB, qty: 1 }, { productId: GAS, qty: 1 }]));
    const [h, g] = lineas;
    expect(h).toMatchObject({ refKey: HAMB, qty: 1, taxScheme: '04', taxRate: 8, base: 9_259, taxAmount: 741, total: 10_000 });
    expect(g).toMatchObject({ refKey: GAS, qty: 1, taxScheme: '01', taxRate: 19, base: 4_201, taxAmount: 799, total: 5_000 });
    expect(g!.ivaAmount).toBe(799);
    expect(h!.ivaAmount).toBe(0);
    const t = totalesDeNota(lineas, []);
    expect(t).toMatchObject({ taxableBase: 13_460, ivaTotal: 799, incTotal: 741, chargeTotal: 0, payableAmount: 15_000 });
    // La propina NO vuelve en la parcial y la nota cuadra como la arma el builder.
    expect(descuadresFactura({ lineas, cargos: [], totales: t })).toEqual([]);
  });

  it('dos parciales que no exceden: la segunda salda exacto el saldo (IVA e INC por separado)', () => {
    const primera = lineasDeDevolucion(referidas, [], pedidas([{ productId: HAMB, qty: 2 }]));
    const previo = new Map([[HAMB, 2]]);
    const plata = new Map([[HAMB, { refund: primera[0]!.total, refundTax: primera[0]!.taxAmount }]]);
    const segunda = lineasDeDevolucion(referidas, [primera], pedidas([{ productId: HAMB, qty: 1 }], previo, plata));
    expect(primera[0]!.base + segunda[0]!.base).toBe(27_778);
    expect(primera[0]!.taxAmount + segunda[0]!.taxAmount).toBe(2_222);
    const saldo = saldoAcreditable(referidas, [primera, segunda]).get(HAMB)!;
    expect(saldo).toEqual({ qty: 0, base: 0, iva: 0, inc: 0 });
  });

  it('una que excede la cantidad → TopeNotaExcedidoError', () => {
    const primera = lineasDeDevolucion(referidas, [], pedidas([{ productId: GAS, qty: 2 }]));
    expect(() =>
      lineasDeDevolucion(referidas, [primera], [{ refKey: GAS, qty: 1, valor: 5_000, impuesto: 798 }]),
    ).toThrow(TopeNotaExcedidoError);
  });

  it('una que excede solo el IVA (misma cantidad) → TopeNotaExcedidoError', () => {
    expect(() =>
      lineasDeDevolucion(referidas, [], [{ refKey: GAS, qty: 2, valor: 10_000, impuesto: 1_598 }]),
    ).toThrow(/IVA \$1598 de \$1597/);
  });

  it('una que excede solo el INC → TopeNotaExcedidoError', () => {
    expect(() =>
      lineasDeDevolucion(referidas, [], [{ refKey: HAMB, qty: 3, valor: 30_000, impuesto: 2_223 }]),
    ).toThrow(/INC \$2223 de \$2222/);
  });

  it('dos pedidas del mismo producto suman contra el mismo saldo', () => {
    expect(() =>
      lineasDeDevolucion(referidas, [], [
        { refKey: GAS, qty: 2, valor: 10_000, impuesto: 1_597 },
        { refKey: GAS, qty: 1, valor: 1, impuesto: 0 },
      ]),
    ).toThrow(TopeNotaExcedidoError);
  });

  it('un producto que no está en el documento no se acredita', () => {
    expect(() => lineasDeDevolucion(referidas, [], [{ refKey: 'otro', qty: 1, valor: 1, impuesto: 0 }])).toThrow(
      NotaNoRelacionableError,
    );
  });

  it('una nota vieja por el total (sin refKey) agota el documento', () => {
    const vieja = doc.lines.map((l) => ({ qty: l.qty, base: l.base, taxScheme: l.taxScheme, taxAmount: l.taxAmount }));
    expect(() => lineasDeDevolucion(referidas, [vieja], pedidas([{ productId: GAS, qty: 1 }]))).toThrow(
      TopeNotaExcedidoError,
    );
  });
});

describe('nota-de-venta · anulación (concepto 2)', () => {
  it('va por el total: todas las líneas, domicilio y propina', () => {
    const { lineas, cargos } = lineasDeAnulacion(referidas, doc.charges, []);
    expect(lineas).toHaveLength(3);
    expect(cargos).toEqual([{ chargeIndicator: true, reason: 'Propina voluntaria', amount: 3_000 }]);
    const t = totalesDeNota(lineas, cargos);
    expect(t).toEqual(doc.totales);
    expect(t.payableAmount).toBe(40_000 + 5_000 + 3_000);
  });

  it('con notas previas no se puede anular entero', () => {
    const parcial = lineasDeDevolucion(referidas, [], pedidas([{ productId: GAS, qty: 1 }]));
    expect(() => lineasDeAnulacion(referidas, doc.charges, [parcial])).toThrow(TopeNotaExcedidoError);
  });
});

describe('cargosDeDevolucion · propina de la devolución parcial (decisión 4)', () => {
  const propina = { chargeIndicator: true, reason: 'Propina voluntaria', amount: 5_000 };

  it('acredita la propina devuelta como cargo, con el motivo del documento', () => {
    const cargos = cargosDeDevolucion([propina], [], 1_250);
    expect(cargos).toEqual([{ chargeIndicator: true, reason: 'Propina voluntaria', amount: 1_250 }]);
    const t = totalesDeNota([], cargos);
    expect(t.chargeTotal).toBe(1_250);
    expect(t.payableAmount).toBe(1_250);
  });

  it('sin propina devuelta no hay cargo', () => {
    expect(cargosDeDevolucion([propina], [], 0)).toEqual([]);
  });

  it('topa contra la facturada menos la ya acreditada por notas previas', () => {
    const previas = [[{ ...propina, amount: 4_000 }]];
    expect(cargosDeDevolucion([propina], previas, 1_000)).toHaveLength(1);
    expect(() => cargosDeDevolucion([propina], previas, 1_001)).toThrow(TopeNotaExcedidoError);
  });

  it('un documento sin propina no admite acreditarla', () => {
    expect(() => cargosDeDevolucion([], [], 1)).toThrow(TopeNotaExcedidoError);
  });
});
