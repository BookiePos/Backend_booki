import { cop } from '../../finance/domain/money.util';

/**
 * Política única de redondeo del documento DIAN (Fase 2 del estudio de FE).
 *
 * - En caja todo es COP entero (`cop()` / `sumCop()` de `money.util.ts`).
 * - En el documento DIAN los montos van a 2 decimales. Dentro de este módulo se
 *   manejan como **centavos enteros** (`Centavos`), no como pesos con decimales,
 *   para que sumar no arrastre el error del flotante.
 * - Cada línea se redondea a centavos una sola vez (`redondearLinea`) y los
 *   totales del documento son la SUMA de las líneas (`totalesDesdeLineas`). Así
 *   el CUFE que recalcula la DIAN con los valores del XML cuadra con el nuestro.
 * - El texto `0.00` se arma en un solo lugar, el borde: `formatearMontoDian`.
 *
 * No es un segundo `Money`: el redondeo sigue siendo `cop()` (aplicado sobre
 * centavos) y no se mezcla con `shared/money/Money.ts`.
 */

/** Monto en centavos de peso: entero, no negativo. 1.785.000,00 COP = 178500000. */
export type Centavos = number;

/** Códigos de tributo del CUFE/CUDE, en el orden fijo del anexo: IVA, INC, ICA. */
export const CODIGOS_IMPUESTO = ['01', '04', '03'] as const;
export type CodigoImpuesto = (typeof CODIGOS_IMPUESTO)[number];

/** Impuestos por código, en centavos. Los que no aplican van en 0. */
export type ImpuestosCentavos = Record<CodigoImpuesto, Centavos>;

export function impuestosEnCero(): ImpuestosCentavos {
  return { '01': 0, '04': 0, '03': 0 };
}

function assertCentavos(c: Centavos, que: string): void {
  if (!Number.isSafeInteger(c) || c < 0) {
    throw new Error(`${que}: se esperaban centavos enteros no negativos y llegó ${c}`);
  }
}

/** Pesos enteros de caja → centavos. Pasa por `cop()`: en caja no hay fracciones. */
export function centavosDeCop(pesos: number): Centavos {
  return cop(pesos) * 100;
}

/**
 * Pesos con decimales (p. ej. una base que sale de dividir por 1,19) →
 * centavos, redondeando a la mitad hacia arriba. `toPrecision(15)` quita el
 * ruido del flotante antes de redondear: 1,005 × 100 da 100,4999… y debe
 * quedar en 101.
 */
export function aCentavos(pesos: number): Centavos {
  return cop(Number((pesos * 100).toPrecision(15)));
}

/**
 * Centavos → texto del anexo técnico: punto decimal, dos decimales, sin
 * separadores de miles ni símbolo. 178500000 → `1785000.00`; 0 → `0.00`.
 * Es el ÚNICO lugar que arma ese texto (CUFE, CUDE, CUNE y XML).
 */
export function formatearMontoDian(c: Centavos): string {
  assertCentavos(c, 'Monto del documento DIAN');
  const s = String(c).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Impuesto de una base a una tarifa en porcentaje (19, 8, 5, 0), redondeado a centavos. */
export function impuestoDeBase(base: Centavos, tarifaPct: number): Centavos {
  assertCentavos(base, 'Base del impuesto');
  if (!(tarifaPct >= 0)) throw new Error(`Tarifa inválida: ${tarifaPct}`);
  return cop(Number(((base * tarifaPct) / 100).toPrecision(15)));
}

/**
 * Desglosa un precio de caja que YA incluye el impuesto (el caso del POS y del
 * restaurante con INC) en base + impuesto, en centavos. La base se redondea y el
 * impuesto es la diferencia, de modo que base + impuesto = precio exacto.
 */
export function desglosarPrecioConImpuesto(
  precioCop: number,
  tarifaPct: number,
): { base: Centavos; impuesto: Centavos } {
  if (!(tarifaPct >= 0)) throw new Error(`Tarifa inválida: ${tarifaPct}`);
  const total = centavosDeCop(precioCop);
  assertCentavos(total, 'Precio con impuesto');
  const base = cop(Number((total / (1 + tarifaPct / 100)).toPrecision(15)));
  return { base, impuesto: total - base };
}

/** Una línea del documento antes de redondear: base e impuestos en pesos (pueden traer decimales). */
export interface LineaMonto {
  base: number;
  impuestos?: Partial<Record<CodigoImpuesto, number>>;
}

/** Una línea ya redondeada a centavos. `total` = base + impuestos, exacto. */
export interface LineaDian {
  base: Centavos;
  impuestos: ImpuestosCentavos;
  total: Centavos;
}

/** Redondea UNA línea a centavos. Un impuesto que no aplica (exento, excluido) queda en 0. */
export function redondearLinea(l: LineaMonto): LineaDian {
  const base = aCentavos(l.base);
  assertCentavos(base, 'Base de la línea');
  const impuestos = impuestosEnCero();
  for (const codigo of CODIGOS_IMPUESTO) {
    const v = aCentavos(l.impuestos?.[codigo] ?? 0);
    assertCentavos(v, `Impuesto ${codigo} de la línea`);
    impuestos[codigo] = v;
  }
  return { base, impuestos, total: base + impuestos['01'] + impuestos['04'] + impuestos['03'] };
}

/** Totales del documento (LegalMonetaryTotal / TaxTotal), en centavos. */
export interface TotalesDian {
  /** LineExtensionAmount: suma de las bases. Es el ValFac del CUFE. */
  valorBruto: Centavos;
  /** TaxTotal por código. ValImp1/2/3 del CUFE. */
  impuestos: ImpuestosCentavos;
  /** PayableAmount: bruto + impuestos. Es el ValTot del CUFE. */
  valorTotal: Centavos;
}

/** Los totales son la suma de las líneas, nunca un cálculo aparte. */
export function totalesDesdeLineas(lineas: readonly LineaDian[]): TotalesDian {
  const impuestos = impuestosEnCero();
  let valorBruto = 0;
  let valorTotal = 0;
  for (const l of lineas) {
    valorBruto += l.base;
    valorTotal += l.total;
    for (const codigo of CODIGOS_IMPUESTO) impuestos[codigo] += l.impuestos[codigo];
  }
  return { valorBruto, impuestos, valorTotal };
}

/**
 * Descuadres entre las líneas y unos totales, con tolerancia 0 (todo es entero
 * en centavos). Vacío = cuadra. Sirve para rechazar un documento antes de
 * firmarlo si alguien armó los totales por otro camino.
 */
export function descuadres(lineas: readonly LineaDian[], totales: TotalesDian): string[] {
  const esperado = totalesDesdeLineas(lineas);
  const fallas: string[] = [];
  const comparar = (que: string, tiene: Centavos, debe: Centavos) => {
    if (tiene !== debe) {
      fallas.push(`${que}: ${formatearMontoDian(tiene)} ≠ suma de líneas ${formatearMontoDian(debe)}`);
    }
  };
  comparar('Valor bruto', totales.valorBruto, esperado.valorBruto);
  for (const codigo of CODIGOS_IMPUESTO) {
    comparar(`Impuesto ${codigo}`, totales.impuestos[codigo], esperado.impuestos[codigo]);
  }
  comparar('Valor total', totales.valorTotal, esperado.valorTotal);
  const bruto = totales.valorBruto + totales.impuestos['01'] + totales.impuestos['04'] + totales.impuestos['03'];
  if (totales.valorTotal !== bruto) {
    fallas.push(
      `Valor total ${formatearMontoDian(totales.valorTotal)} ≠ bruto + impuestos ${formatearMontoDian(bruto)}`,
    );
  }
  return fallas;
}

/** Igual que `descuadres`, pero lanza con todos los descuadres juntos. */
export function assertCuadre(lineas: readonly LineaDian[], totales: TotalesDian): void {
  const fallas = descuadres(lineas, totales);
  if (fallas.length > 0) throw new Error(`El documento no cuadra: ${fallas.join('; ')}`);
}
