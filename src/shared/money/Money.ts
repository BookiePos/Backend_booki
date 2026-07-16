/**
 * Money — value object para dinero en COP.
 *
 * REGLA NO NEGOCIABLE: el dinero nunca se representa como `number` (float).
 * Internamente se guarda en centavos como `bigint` y se persiste como
 * Decimal128 en Mongo. Esto elimina errores de redondeo en el ledger.
 *
 * Esqueleto del scaffold — completar operaciones al implementar core-ledger.
 */
export class Money {
  /** Monto en la mínima unidad (centavos). */
  private readonly cents: bigint;
  readonly currency: string;

  private constructor(cents: bigint, currency: string) {
    this.cents = cents;
    this.currency = currency;
  }

  static fromCents(cents: bigint, currency = "COP"): Money {
    return new Money(cents, currency);
  }

  /** Crea Money desde un string decimal ("22000.00"). No usar números float. */
  static fromDecimalString(value: string, currency = "COP"): Money {
    if (!/^-?\d+(\.\d{1,2})?$/.test(value)) {
      throw new Error(`Monto inválido: ${value}`);
    }
    const [intPart = "0", fracPart = ""] = value.replace("-", "").split(".");
    const frac = (fracPart + "00").slice(0, 2);
    const cents = BigInt(intPart) * 100n + BigInt(frac);
    return new Money(value.startsWith("-") ? -cents : cents, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  toCents(): bigint {
    return this.cents;
  }

  /** Representación para persistir como Decimal128 (string decimal). */
  toDecimalString(): string {
    const neg = this.cents < 0n;
    const abs = neg ? -this.cents : this.cents;
    const int = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, "0");
    return `${neg ? "-" : ""}${int}.${frac}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`Moneda incompatible: ${this.currency} vs ${other.currency}`);
    }
  }
}
