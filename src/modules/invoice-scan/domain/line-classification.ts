/**
 * ¿Este renglón de la factura es mercancía que entra al inventario, o un gasto?
 *
 * La distinción no es un capricho contable: la mercancía es un **activo** hasta
 * que se vende (y su costo sale al venderla), mientras que un flete o un
 * servicio se consumen en el acto. Registrar mercancía como gasto infla los
 * gastos del mes, deja el inventario en cero —el POS no podría venderla— y
 * vuelve a cobrar el costo cuando se venda.
 *
 * Esto es solo una PROPUESTA: la pantalla de revisión la muestra marcada y el
 * usuario la cambia con un clic. Dominio puro, testeable sin red.
 */
import type { ExtractedLine } from './invoice-extraction';
import { normalizeText } from './text-normalize';
import type { LineTarget } from './invoice-scan.constants';

/**
 * Palabras que delatan un concepto no inventariable. Se comparan sobre el texto
 * normalizado, así que van sin tildes.
 */
const EXPENSE_HINTS = [
  'flete',
  'fletes',
  'transporte',
  'domicilio',
  'envio',
  'acarreo',
  'servicio',
  'servicios',
  'mano de obra',
  'instalacion',
  'mantenimiento',
  'reparacion',
  'asesoria',
  'honorarios',
  'arriendo',
  'alquiler',
  'publicidad',
  'comision',
  'recargo',
  'manejo',
  'papeleria',
  'aseo',
  'redondeo',
];

/** Conceptos que no son ni compra ni gasto: descuentos y ajustes del pie. */
const IGNORE_HINTS = ['descuento', 'dcto', 'subtotal', 'total', 'iva', 'retencion'];

export interface LineProposal {
  target: LineTarget;
  /** Por qué se propuso esto, para poder explicarlo en la interfaz. */
  reason: string;
}

/**
 * Propone el destino de una línea.
 *
 * El criterio principal es el texto; la forma de la línea desempata. Un renglón
 * con cantidad Y valor unitario tiene pinta de mercancía aunque el nombre no
 * diga nada, mientras que uno suelto con solo un importe suele ser un cargo.
 */
export function proposeLineTarget(line: ExtractedLine): LineProposal {
  const text = normalizeText(line.description);

  if (IGNORE_HINTS.some((hint) => text === hint || text.startsWith(`${hint} `))) {
    return { target: 'ignore', reason: 'Parece un renglón de totales o un descuento' };
  }

  const hint = EXPENSE_HINTS.find(
    (word) => text === word || text.includes(` ${word}`) || text.startsWith(`${word} `),
  );
  if (hint) {
    return { target: 'expense', reason: `Menciona "${hint}": no es mercancía` };
  }

  if (line.qty === undefined && line.unitCost === undefined) {
    return { target: 'expense', reason: 'Sin cantidad ni valor unitario' };
  }

  return { target: 'inventory', reason: 'Tiene cantidad y valor unitario' };
}

/**
 * ¿La cantidad sirve para una orden de compra?
 *
 * `PurchaseLineDto.qty` es entero (`@IsInt() @Min(1)`), así que una línea de
 * "2,5 kg" no puede entrar por ahí. En vez de redondear a escondidas —que
 * falsearía el inventario— se marca para que la persona la ajuste o la pase a
 * gasto.
 */
export function qtyFitsPurchaseLine(qty?: number): boolean {
  return qty !== undefined && Number.isInteger(qty) && qty >= 1;
}
