import { cop, sumBy } from '../../finance/domain/money.util';
import type { SaleTaxKind } from '../../core-tax/domain/sale-tax';
import { UNIT_CODE } from './einvoicing.constants';
import {
  assertCuadre,
  centavosDeCop,
  redondearLinea,
  type ImpuestosCentavos,
  type TotalesDian,
} from './redondeo';

/**
 * Líneas y totales del documento electrónico a partir de una venta (Fase 2 del
 * estudio de FE y concepto contable 2026-10-29, puntos 2, 3 y 4).
 *
 * - Cada línea lleva su tributo real: `01` IVA o `04` INC con su tarifa; la que
 *   no causa impuesto (no responsable, excluida) va sin tributo. Los montos son
 *   los `taxBase`/`taxAmount` que la venta ya guardó: aquí NO se vuelve a
 *   desglosar, así el documento dice lo mismo que la venta y el libro.
 * - El domicilio cobrado por el restaurante va como línea propia con el
 *   impuesto que guardó la venta (`deliveryTax*`). Una venta anterior a ese
 *   campo lo lleva sin tributo, como se registró: no se reescribe.
 * - El INC de bolsas (tributo `22`, art. 512-15 ET) va en la línea de la bolsa,
 *   por unidad. No entra en los pares del CUFE (01/04/03) pero sí en el total.
 * - La propina es un cargo de documento no gravado (`AllowanceCharge`,
 *   `ChargeIndicator=true`): no es base ni impuesto, pero sí suma al
 *   `PayableAmount`, que es el `ValTot` del CUFE (Ley 1935/2018, ET 512-9).
 *
 * Todo en COP entero (lo que guarda la venta). El paso a centavos del CUFE es
 * `centavosDeCop`, en un solo lugar.
 */

/** Códigos de tributo de línea que emite BookiPos hoy. */
export type TributoLinea = '01' | '04';

/** Tributo por unidad de una línea (hoy solo el INC de bolsas, `22`). */
export interface TributoPorUnidad {
  codigo: '22';
  /** Unidades gravadas (bolsas entregadas). */
  unidades: number;
  /** Valor por unidad, en pesos. */
  valorUnitario: number;
  /** unidades × valorUnitario, en pesos. */
  valor: number;
}

export interface LineaDocumento {
  code?: string;
  description: string;
  qty: number;
  unitCode: string;
  unitPrice: number;
  discountAmount: number;
  /** Base de la línea (neta de descuento, sin impuesto). */
  base: number;
  /** Tributo de la línea; ausente = sin tributo. */
  taxScheme?: TributoLinea;
  taxRate: number;
  taxAmount: number;
  /** Solo IVA (compatibilidad con la pantalla): 0 en INC o sin tributo. */
  ivaRate: number;
  ivaAmount: number;
  /** Tributo por unidad (INC de bolsas), aparte del ad valorem. */
  perUnitTax?: TributoPorUnidad;
  /** base + impuesto ad valorem + tributo por unidad. */
  total: number;
}

/** Cargo (o descuento) de documento: hoy solo la propina. */
export interface CargoDocumento {
  chargeIndicator: boolean;
  reason: string;
  amount: number;
}

export interface TotalesDocumento {
  /** LineExtensionAmount: Σ bases. ValFac del CUFE. */
  taxableBase: number;
  ivaTotal: number;
  incTotal: number;
  icaTotal: number;
  /** Σ tributo 22 (bolsas). */
  bagTaxTotal: number;
  /** TaxInclusiveAmount: bases + todos los tributos. */
  taxInclusiveAmount: number;
  /** ChargeTotalAmount: Σ cargos de documento (propina). */
  chargeTotal: number;
  /** PayableAmount: lo que paga el cliente. ValTot del CUFE. */
  payableAmount: number;
}

export interface DocumentoDeVenta {
  lines: LineaDocumento[];
  charges: CargoDocumento[];
  totales: TotalesDocumento;
  /** Lo que entra al CUFE/CUDE, en centavos. */
  codigoUnico: {
    valorBruto: number;
    impuestos: ImpuestosCentavos;
    valorTotal: number;
  };
}

/** Lo que se lee de una línea de la venta. */
export interface LineaVenta {
  sku?: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal?: number;
  discountAmount?: number;
  ivaRate?: number;
  taxKind?: SaleTaxKind;
  taxRate?: number;
  taxBase?: number;
  taxAmount?: number;
  bagTaxUnit?: number;
  bagTax?: number;
}

/** Lo que se lee de la venta. */
export interface VentaParaDocumento {
  lines: LineaVenta[];
  tip?: number;
  deliveryFee?: number;
  deliveryTaxKind?: SaleTaxKind;
  deliveryTaxRate?: number;
  deliveryTaxBase?: number;
  deliveryTax?: number;
}

export const DESCRIPCION_DOMICILIO = 'Servicio de domicilio';
export const CODIGO_DOMICILIO = 'DOMICILIO';
export const MOTIVO_PROPINA = 'Propina voluntaria';

/**
 * Tributo de una línea según lo que guardó la venta. `inc` → 04; `iva` con
 * tarifa → 01; `ninguno` o IVA al 0 % → sin tributo (la venta no distingue el
 * exento del excluido; los dos quedan sin TaxTotal hasta que lo distinga).
 */
function tributoDe(
  kind: SaleTaxKind | undefined,
  tarifa: number,
  impuesto: number,
): TributoLinea | undefined {
  if (kind === 'ninguno') return undefined;
  if (kind === 'inc') return '04';
  return tarifa > 0 || impuesto > 0 ? '01' : undefined;
}

function linea(o: {
  code?: string;
  description: string;
  qty: number;
  unitPrice: number;
  discountAmount: number;
  base: number;
  kind: SaleTaxKind | undefined;
  tarifa: number;
  impuesto: number;
  perUnitTax?: TributoPorUnidad;
}): LineaDocumento {
  const taxScheme = tributoDe(o.kind, o.tarifa, o.impuesto);
  // Sin tributo no hay impuesto que declarar: si la venta guardó algo, va a la base.
  const base = taxScheme ? cop(o.base) : cop(o.base + o.impuesto);
  const taxAmount = taxScheme ? cop(o.impuesto) : 0;
  const taxRate = taxScheme ? o.tarifa : 0;
  return {
    code: o.code,
    description: o.description,
    qty: o.qty,
    unitCode: UNIT_CODE,
    unitPrice: o.unitPrice,
    discountAmount: o.discountAmount,
    base,
    taxScheme,
    taxRate,
    taxAmount,
    ivaRate: taxScheme === '01' ? taxRate : 0,
    ivaAmount: taxScheme === '01' ? taxAmount : 0,
    perUnitTax: o.perUnitTax,
    total: base + taxAmount + (o.perUnitTax?.valor ?? 0),
  };
}

function lineaDeVenta(l: LineaVenta): LineaDocumento {
  const kind = l.taxKind ?? 'iva';
  const tarifa = l.taxRate || (kind === 'iva' ? (l.ivaRate ?? 0) : 0);
  let base = l.taxBase ?? 0;
  const impuesto = l.taxAmount ?? 0;
  // Venta anterior al desglose por línea: sin base ni impuesto guardados, la
  // línea vale su neto (no se inventa un desglose).
  if (base === 0 && impuesto === 0 && l.lineTotal) {
    base = cop(l.lineTotal - (l.discountAmount ?? 0));
  }
  const bolsa = cop(l.bagTax ?? 0);
  return linea({
    code: l.sku,
    description: l.name,
    qty: l.qty,
    unitPrice: l.unitPrice,
    discountAmount: l.discountAmount ?? 0,
    base,
    kind,
    tarifa,
    impuesto,
    perUnitTax:
      bolsa > 0
        ? {
            codigo: '22',
            unidades: l.qty,
            valorUnitario: cop(l.bagTaxUnit ?? bolsa / (l.qty || 1)),
            valor: bolsa,
          }
        : undefined,
  });
}

function lineaDomicilio(v: VentaParaDocumento): LineaDocumento | undefined {
  const fee = cop(v.deliveryFee ?? 0);
  if (fee <= 0) return undefined;
  // Venta vieja (sin `deliveryTaxKind`): el domicilio se registró sin
  // impuesto y así va.
  const kind: SaleTaxKind = v.deliveryTaxKind ?? 'ninguno';
  const impuesto = v.deliveryTaxKind ? cop(v.deliveryTax ?? 0) : 0;
  const base = v.deliveryTaxKind ? cop(v.deliveryTaxBase ?? fee - impuesto) : fee;
  return linea({
    code: CODIGO_DOMICILIO,
    description: DESCRIPCION_DOMICILIO,
    qty: 1,
    unitPrice: fee,
    discountAmount: 0,
    base,
    kind,
    tarifa: v.deliveryTaxRate ?? 0,
    impuesto,
  });
}

/** Arma el documento de una venta y comprueba que cuadre (tolerancia 0). */
export function documentoDeVenta(v: VentaParaDocumento): DocumentoDeVenta {
  const lines = v.lines.map(lineaDeVenta);
  const domicilio = lineaDomicilio(v);
  if (domicilio) lines.push(domicilio);

  const tip = cop(v.tip ?? 0);
  const charges: CargoDocumento[] =
    tip > 0 ? [{ chargeIndicator: true, reason: MOTIVO_PROPINA, amount: tip }] : [];

  const de = (codigo: TributoLinea) =>
    sumBy(lines, (l) => (l.taxScheme === codigo ? l.taxAmount : 0));
  const taxableBase = sumBy(lines, (l) => l.base);
  const ivaTotal = de('01');
  const incTotal = de('04');
  const icaTotal = 0;
  const bagTaxTotal = sumBy(lines, (l) => l.perUnitTax?.valor ?? 0);
  const taxInclusiveAmount = taxableBase + ivaTotal + incTotal + icaTotal + bagTaxTotal;
  const chargeTotal = sumBy(charges, (c) => (c.chargeIndicator ? c.amount : -c.amount));
  const payableAmount = taxInclusiveAmount + chargeTotal;

  // Las líneas (ad valorem) y los totales tienen que cuadrar al centavo: es lo
  // que la DIAN recalcula para verificar el CUFE.
  const lineasDian = lines.map((l) =>
    redondearLinea({
      base: l.base,
      impuestos: l.taxScheme ? { [l.taxScheme]: l.taxAmount } : {},
    }),
  );
  const impuestos: ImpuestosCentavos = {
    '01': centavosDeCop(ivaTotal),
    '04': centavosDeCop(incTotal),
    '03': centavosDeCop(icaTotal),
  };
  const totalesDian: TotalesDian = {
    valorBruto: centavosDeCop(taxableBase),
    impuestos,
    valorTotal: centavosDeCop(taxableBase + ivaTotal + incTotal + icaTotal),
  };
  assertCuadre(lineasDian, totalesDian);

  return {
    lines,
    charges,
    totales: {
      taxableBase,
      ivaTotal,
      incTotal,
      icaTotal,
      bagTaxTotal,
      taxInclusiveAmount,
      chargeTotal,
      payableAmount,
    },
    codigoUnico: {
      valorBruto: totalesDian.valorBruto,
      impuestos,
      valorTotal: centavosDeCop(payableAmount),
    },
  };
}
