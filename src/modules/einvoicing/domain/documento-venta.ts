import { cop, sumBy } from '../../finance/domain/money.util';
import type { SaleTaxKind } from '../../core-tax/domain/sale-tax';
import type { IvaType } from '../../catalog/domain/catalog.constants';
import { prorateCop } from '../../sales/domain/sale-amounts';
import { UNIT_CODE } from './einvoicing.constants';
import {
  centavosDeCop,
  descuadres,
  redondearLinea,
  type ImpuestosCentavos,
  type TotalesDian,
} from './redondeo';

/**
 * Líneas y totales del documento electrónico a partir de una venta (Fase 2 del
 * estudio de FE y concepto contable 2026-10-29, puntos 2, 3 y 4).
 *
 * - Cada línea lleva su tributo real: `01` IVA o `04` INC con su tarifa. Un
 *   producto EXENTO lleva `01` al 0 % (TaxTotal con TaxAmount 0.00); uno
 *   EXCLUIDO o una venta sin impuesto (`ninguno`) va sin tributo (anexo FEV
 *   1.9, reglas FAX06/FAX07). Los montos son los `taxBase`/`taxAmount` que la
 *   venta ya guardó: aquí NO se vuelve a desglosar, así el documento dice lo
 *   mismo que la venta y el libro.
 * - Las ventas anteriores a `taxTreatment` no distinguen el exento del
 *   excluido: una línea de IVA al 0 % sin ese dato va sin tributo, como antes.
 * - El domicilio cobrado por el restaurante va como línea propia con el
 *   impuesto que guardó la venta (`deliveryTax*`). Una venta anterior a ese
 *   campo lo lleva sin tributo, como se registró: no se reescribe.
 * - El INC de bolsas (tributo `22`, art. 512-15 ET) va en la línea de la bolsa,
 *   por unidad. No entra en los pares del CUFE (01/04/03) pero sí en el total.
 * - La propina es un cargo de documento no gravado (`AllowanceCharge`,
 *   `ChargeIndicator=true`): no es base ni impuesto, pero sí suma al
 *   `PayableAmount`, que es el `ValTot` del CUFE (Ley 1935/2018, ET 512-9).
 * - `discountTotal` de la venta es SOLO informativo: las bases de las líneas
 *   ya vienen netas de todo descuento (de línea y de venta prorrateado), así
 *   que no se usa como `AllowanceTotalAmount` ni se resta otra vez.
 *
 * Control contra lo cobrado: `PayableAmount` tiene que ser exactamente
 * `total + tip + deliveryFee` de la venta (tolerancia 0). Si no, se lanza
 * `DocumentoDescuadradoError` y la emisión se aborta antes de tocar cupo o
 * folio.
 *
 * Todo en COP entero. El paso a centavos del CUFE es `centavosDeCop`.
 */

/** El documento no cuadra (consigo mismo o con lo cobrado). La emisión lo convierte en 400. */
export class DocumentoDescuadradoError extends Error {}

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
  /** Informativo: la base ya viene neta de descuento. */
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
  /** TaxExclusiveAmount: Σ bases de las líneas con TaxTotal, incluidas las exentas (FAU04). */
  taxExclusiveAmount: number;
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
  /** Algo que revisar sin bloquear la emisión. */
  aviso?: string;
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
  taxTreatment?: IvaType;
  taxBase?: number;
  taxAmount?: number;
  bagTaxUnit?: number;
  bagTax?: number;
}

/** Lo que se lee de la venta. */
export interface VentaParaDocumento {
  lines: LineaVenta[];
  /** Lo cobrado por los productos (con bolsas, sin propina ni domicilio). */
  total: number;
  /** Informativo (ver arriba); solo se usa para repartir el descuento de una venta vieja. */
  discountTotal?: number;
  tip?: number;
  deliveryFee?: number;
  deliveryTaxKind?: SaleTaxKind;
  deliveryTaxRate?: number;
  deliveryTaxBase?: number;
  deliveryTax?: number;
}

export interface OpcionesDocumento {
  /**
   * El negocio causa INC (lo decide quien llama con `causesInc()` de
   * `core-tax/domain/sale-tax.ts` o con las líneas de la venta): una venta
   * vieja con domicilio sin impuesto deja aviso.
   */
  causaInc?: boolean;
}

/** El primer TaxTotal de una línea del XML y su TaxableAmount. */
export interface PrimerTributo {
  codigo: TributoLinea | '22';
  /** TaxableAmount de ese TaxTotal, en pesos. */
  taxableAmount: number;
}

/**
 * Primer TaxTotal de la línea, en el orden en que va en el XML: el tributo ad
 * valorem (01/04) primero y el 22 de la bolsa después. Sin tributo, no hay.
 *
 * Es la fuente única de dos cosas que tienen que coincidir: el
 * `TaxExclusiveAmount` del documento (regla FAU04: la suma EXACTA de los
 * `TaxableAmount` del primer TaxTotal de cada línea) y el armado del XML de
 * la Fase 5, que debe usar este mismo helper para cada línea.
 *
 * Una línea con solo el tributo 22 toma su base como TaxableAmount. En la
 * práctica no ocurre (el INC de bolsas solo lo cobra el responsable de IVA, así
 * que la bolsa siempre trae su 01): confirmar con el anexo al armar el XML.
 */
export function primerTributo(l: LineaDocumento): PrimerTributo | undefined {
  if (l.taxScheme) return { codigo: l.taxScheme, taxableAmount: l.base };
  if (l.perUnitTax) return { codigo: '22', taxableAmount: l.base };
  return undefined;
}

export const DESCRIPCION_DOMICILIO = 'Servicio de domicilio';
export const CODIGO_DOMICILIO = 'DOMICILIO';
export const MOTIVO_PROPINA = 'Propina voluntaria';
export const AVISO_DOMICILIO_SIN_INC =
  'El domicilio de esta venta se registró sin INC; revisar con el contador.';

/**
 * Tributo de una línea según lo que guardó la venta: `inc` → 04; `iva`
 * gravado → 01; `iva` exento → 01 al 0 %; excluido, `ninguno` o IVA al 0 %
 * sin tratamiento (venta vieja) → sin tributo.
 */
function tributoDe(
  kind: SaleTaxKind | undefined,
  tratamiento: IvaType | undefined,
  tarifa: number,
  impuesto: number,
): TributoLinea | undefined {
  if (kind === 'ninguno') return undefined;
  if (kind === 'inc') return '04';
  if (tratamiento === 'excluido') return undefined;
  if (tratamiento === 'exento') return '01';
  return tarifa > 0 || impuesto > 0 ? '01' : undefined;
}

function linea(o: {
  code?: string;
  description: string;
  qty: number;
  unitPrice: number;
  discountAmount: number;
  /** Neto de la línea (base + impuesto ad valorem), en pesos. */
  neto: number;
  impuesto: number;
  kind: SaleTaxKind | undefined;
  tratamiento?: IvaType;
  tarifa: number;
  perUnitTax?: TributoPorUnidad;
}): LineaDocumento {
  const taxScheme = tributoDe(o.kind, o.tratamiento, o.tarifa, o.impuesto);
  // El impuesto se redondea a peso y la base es el residuo: una venta vieja
  // con decimales (1.000,50 + 190,50) no suma un peso de más (1.000 + 191).
  const neto = cop(o.neto);
  const taxAmount = taxScheme ? cop(o.impuesto) : 0;
  const base = neto - taxAmount;
  const exento = taxScheme === '01' && o.tratamiento === 'exento';
  const taxRate = taxScheme && !exento ? o.tarifa : 0;
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

function tributoBolsa(l: LineaVenta): TributoPorUnidad | undefined {
  const bolsa = cop(l.bagTax ?? 0);
  if (bolsa <= 0) return undefined;
  return {
    codigo: '22',
    unidades: l.qty,
    valorUnitario: cop(l.bagTaxUnit ?? bolsa / (l.qty || 1)),
    valor: bolsa,
  };
}

/**
 * Líneas de la venta. El respaldo «sin desglose» aplica solo si la venta
 * ENTERA no tiene `taxBase` ni `taxAmount` (venta anterior al desglose por
 * línea): entonces cada línea vale su neto (bruto − descuento de línea − su
 * parte del descuento de venta, con `prorateCop`) y va sin tributo, sin
 * inventar un desglose. Una línea en 0 dentro de una venta con desglose (un
 * descuento del 100 %, o la parte que `prorateCop` dejó en 0) vale 0, nunca su
 * bruto.
 */
function lineasDeVenta(v: VentaParaDocumento): LineaDocumento[] {
  const sinDesglose = v.lines.every((l) => !l.taxBase && !l.taxAmount);
  if (sinDesglose) {
    const netosLinea = v.lines.map((l) => cop((l.lineTotal ?? 0) - (l.discountAmount ?? 0)));
    const descuentoLineas = sumBy(v.lines, (l) => l.discountAmount ?? 0);
    const descuentoVenta = Math.max(cop(v.discountTotal ?? 0) - descuentoLineas, 0);
    const partes = prorateCop(descuentoVenta, netosLinea);
    return v.lines.map((l, i) =>
      linea({
        code: l.sku,
        description: l.name,
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountAmount: l.discountAmount ?? 0,
        neto: Math.max((netosLinea[i] ?? 0) - (partes[i] ?? 0), 0),
        impuesto: 0,
        kind: 'ninguno',
        tarifa: 0,
        perUnitTax: tributoBolsa(l),
      }),
    );
  }
  return v.lines.map((l) => {
    const kind = l.taxKind ?? 'iva';
    return linea({
      code: l.sku,
      description: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount ?? 0,
      neto: (l.taxBase ?? 0) + (l.taxAmount ?? 0),
      impuesto: l.taxAmount ?? 0,
      kind,
      tratamiento: kind === 'iva' ? l.taxTreatment : undefined,
      tarifa: l.taxRate || (kind === 'iva' ? (l.ivaRate ?? 0) : 0),
      perUnitTax: tributoBolsa(l),
    });
  });
}

function lineaDomicilio(v: VentaParaDocumento): LineaDocumento | undefined {
  const fee = cop(v.deliveryFee ?? 0);
  if (fee <= 0) return undefined;
  // Venta vieja (sin `deliveryTaxKind`): el domicilio se registró sin
  // impuesto y así va.
  const conImpuesto = Boolean(v.deliveryTaxKind);
  return linea({
    code: CODIGO_DOMICILIO,
    description: DESCRIPCION_DOMICILIO,
    qty: 1,
    unitPrice: fee,
    discountAmount: 0,
    neto: fee,
    impuesto: conImpuesto ? (v.deliveryTax ?? 0) : 0,
    kind: v.deliveryTaxKind ?? 'ninguno',
    tarifa: v.deliveryTaxRate ?? 0,
  });
}

/** Arma el documento de una venta y comprueba que cuadre (tolerancia 0). */
export function documentoDeVenta(
  v: VentaParaDocumento,
  opciones: OpcionesDocumento = {},
): DocumentoDeVenta {
  const lines = lineasDeVenta(v);
  const domicilio = lineaDomicilio(v);
  if (domicilio) lines.push(domicilio);

  const tip = cop(v.tip ?? 0);
  const charges: CargoDocumento[] =
    tip > 0 ? [{ chargeIndicator: true, reason: MOTIVO_PROPINA, amount: tip }] : [];

  const de = (codigo: TributoLinea) =>
    sumBy(lines, (l) => (l.taxScheme === codigo ? l.taxAmount : 0));
  const taxableBase = sumBy(lines, (l) => l.base);
  // FAU04: exactamente la suma del TaxableAmount del primer TaxTotal de cada línea.
  const taxExclusiveAmount = sumBy(lines, (l) => primerTributo(l)?.taxableAmount ?? 0);
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
  const fallas = descuadres(lineasDian, totalesDian);
  if (fallas.length > 0) {
    throw new DocumentoDescuadradoError(`El documento no cuadra: ${fallas.join('; ')}`);
  }

  // Y el total tiene que ser lo que se le cobró al cliente, al peso.
  const cobrado = cop(v.total) + tip + cop(v.deliveryFee ?? 0);
  if (payableAmount !== cobrado) {
    throw new DocumentoDescuadradoError(
      `El documento suma $${payableAmount} y la venta cobró $${cobrado} (productos + propina + domicilio). ` +
        'No se emite: revisa la venta con soporte antes de facturarla.',
    );
  }

  const domicilioSinInc =
    domicilio !== undefined &&
    !v.deliveryTaxKind &&
    opciones.causaInc === true;

  return {
    lines,
    charges,
    totales: {
      taxableBase,
      taxExclusiveAmount,
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
    aviso: domicilioSinInc ? AVISO_DOMICILIO_SIN_INC : undefined,
  };
}
