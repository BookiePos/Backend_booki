import { describe, expect, it } from 'vitest';
import { propinaDeDevolucion } from './sale-return';
import { propinaCobrada } from './sale-payments';

/** Devuelve en pedazos y acumula como lo hace `SaleReturnsService`. */
function enPedazos(propina: number, vendido: number, pedazos: number[]): number[] {
  let antes = 0;
  let propinaAntes = 0;
  return pedazos.map((ahora) => {
    const t = propinaDeDevolucion({ propina, vendido, devueltoAntes: antes, devueltoAhora: ahora, propinaAntes });
    antes += ahora;
    propinaAntes += t;
    return t;
  });
}

describe('propina en la devolución parcial (decisión 4)', () => {
  it('vuelve en proporción a lo devuelto', () => {
    expect(propinaDeDevolucion({ propina: 10_000, vendido: 100_000, devueltoAntes: 0, devueltoAhora: 25_000, propinaAntes: 0 })).toBe(2_500);
  });

  it('redondeo acumulado: tres tercios de $1.000 suman $1.000, no $999', () => {
    const partes = enPedazos(1_000, 30_000, [10_000, 10_000, 10_000]);
    expect(partes.reduce((s, x) => s + x, 0)).toBe(1_000);
    for (const p of partes) expect(Number.isInteger(p)).toBe(true);
  });

  it('pedazos impares: devuelto todo, vuelve la propina entera', () => {
    const partes = enPedazos(4_999, 61_627, [7_001, 13_333, 1, 41_292]);
    expect(partes.reduce((s, x) => s + x, 0)).toBe(4_999);
  });

  it('a mitad de camino nunca pasa de lo proporcional', () => {
    const [a, b] = enPedazos(5_000, 90_001, [30_000, 15_000]);
    expect(a! + b!).toBe(Math.round((5_000 * 45_000) / 90_001));
  });

  it('sin propina, o sin nada vendido, no vuelve nada', () => {
    expect(propinaDeDevolucion({ propina: 0, vendido: 10_000, devueltoAntes: 0, devueltoAhora: 10_000, propinaAntes: 0 })).toBe(0);
    expect(propinaDeDevolucion({ propina: 500, vendido: 0, devueltoAntes: 0, devueltoAhora: 0, propinaAntes: 0 })).toBe(0);
  });

  it('nunca negativa ni por encima de la propina, aunque lo previo venga inflado', () => {
    expect(propinaDeDevolucion({ propina: 1_000, vendido: 10_000, devueltoAntes: 5_000, devueltoAhora: 1_000, propinaAntes: 900 })).toBe(0);
    expect(propinaDeDevolucion({ propina: 1_000, vendido: 10_000, devueltoAntes: 0, devueltoAhora: 99_000, propinaAntes: 0 })).toBe(1_000);
  });
});

describe('propinaCobrada', () => {
  it('la venta de contado devuelve su propina', () => {
    expect(propinaCobrada({ total: 10_000, tip: 1_000, payment: { method: 'cash' } })).toBe(1_000);
  });

  it('el fiado entero no registró propina en el libro: no hay qué devolver', () => {
    expect(propinaCobrada({ total: 10_000, tip: 1_000, payment: { method: 'credit' } })).toBe(0);
  });

  it('el cobro mixto sí la registró, con la parte pagada', () => {
    expect(
      propinaCobrada({
        total: 10_000,
        tip: 1_000,
        payments: [
          { method: 'cash', amount: 6_000 },
          { method: 'credit', amount: 5_000 },
        ],
      }),
    ).toBe(1_000);
  });
});
