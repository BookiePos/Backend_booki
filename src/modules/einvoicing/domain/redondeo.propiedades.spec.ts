import { describe, expect, it } from 'vitest';
import {
  aCentavos,
  descuadres,
  formatearMontoDian,
  impuestoDeBase,
  redondearLinea,
  totalesDesdeLineas,
  type LineaDian,
} from './redondeo';

/**
 * Fase 11 · redondeo, por barrido. `redondeo.spec.ts` fija ejemplos; aquí se
 * recorren rangos completos contra aritmética entera exacta (BigInt), que es
 * como la DIAN recalcula. Un centavo de diferencia en una línea es un CUFE que
 * no cuadra (FAD06) o un total que no es la suma de las líneas (FAU14).
 */

/** Generador determinista (LCG): el barrido es el mismo en cada corrida. */
function azar(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('aCentavos · mitad hacia arriba, sin ruido del flotante', () => {
  it('todo valor con milésima 5 sube al centavo siguiente (0,005 … 3.000,005)', () => {
    const malos: number[] = [];
    for (let c = 0; c < 300_000; c += 1) {
      const pesos = (c * 10 + 5) / 1000;
      if (aCentavos(pesos) !== c + 1) malos.push(pesos);
    }
    expect(malos).toEqual([]);
  });

  it('milésimas 4 bajan y 6 suben, también en montos de miles de millones', () => {
    for (const base of [0, 1_000, 1_000_000, 1_000_000_000, 90_000_000_000]) {
      for (let c = 0; c < 100; c += 1) {
        const exacto = base * 100 + c;
        expect(aCentavos((exacto * 10 + 4) / 1000), `${base}+${c} (…4)`).toBe(exacto);
        expect(aCentavos((exacto * 10 + 5) / 1000), `${base}+${c} (…5)`).toBe(exacto + 1);
        expect(aCentavos((exacto * 10 + 6) / 1000), `${base}+${c} (…6)`).toBe(exacto + 1);
      }
    }
  });

  it('un monto que ya está en centavos no cambia (ida y vuelta por el texto del XML)', () => {
    const r = azar(11);
    for (let i = 0; i < 20_000; i += 1) {
      const c = Math.floor(r() * 5_000_000_000_00);
      const texto = formatearMontoDian(c);
      expect(texto).toMatch(/^\d+\.\d{2}$/);
      expect(aCentavos(Number(texto)), texto).toBe(c);
      expect(BigInt(texto.replace('.', ''))).toBe(BigInt(c));
    }
  });
});

describe('impuestoDeBase · igual a la aritmética entera exacta', () => {
  const exacto = (base: number, milesimasPct: number): number =>
    Number((BigInt(base) * BigInt(milesimasPct) + 50_000n) / 100_000n);

  it.each([19, 8, 5, 4, 0])('tarifa %s %%: todas las bases de 0 a 3.000,00 y una de cada 97 hasta 300.000,00', (tarifa) => {
    const malos: number[] = [];
    for (let base = 0; base <= 30_000_000; base += base < 300_000 ? 1 : 97) {
      if (impuestoDeBase(base, tarifa) !== exacto(base, tarifa * 1000)) malos.push(base);
    }
    expect(malos).toEqual([]);
  });

  it('bases al azar hasta 5.000 millones de pesos, a 19, 8 y 5 %', () => {
    const r = azar(7);
    const malos: string[] = [];
    for (let i = 0; i < 30_000; i += 1) {
      const base = Math.floor(r() * 5_000_000_000_00);
      for (const tarifa of [19, 8, 5]) {
        if (impuestoDeBase(base, tarifa) !== exacto(base, tarifa * 1000)) malos.push(`${base} @ ${tarifa}`);
      }
    }
    expect(malos).toEqual([]);
  });

  it('el resultado siempre es centavos enteros que el XML puede escribir', () => {
    const r = azar(3);
    for (let i = 0; i < 5_000; i += 1) {
      const v = impuestoDeBase(Math.floor(r() * 1_000_000_00), [19, 8, 5][i % 3]!);
      expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
      expect(() => formatearMontoDian(v)).not.toThrow();
    }
  });
});

describe('líneas y totales · lo que la DIAN recalcula', () => {
  function lineasAlAzar(r: () => number, n: number): LineaDian[] {
    return Array.from({ length: n }, () => {
      const base = Math.floor(r() * 500_000_00) / 100;
      const tributo = (['01', '04', undefined] as const)[Math.floor(r() * 3)];
      const tarifa = tributo === '01' ? [19, 5, 0][Math.floor(r() * 3)]! : 8;
      // El impuesto llega con decimales de más, como sale de dividir un precio con impuesto incluido.
      return redondearLinea({ base, impuestos: tributo ? { [tributo]: (base * tarifa) / 100 } : {} });
    });
  }

  it('1.000 documentos al azar: los totales son la suma exacta de las líneas y cuadran con tolerancia 0', () => {
    const r = azar(2026);
    for (let d = 0; d < 1_000; d += 1) {
      const lineas = lineasAlAzar(r, 1 + Math.floor(r() * 25));
      const t = totalesDesdeLineas(lineas);
      const suma = (f: (l: LineaDian) => number): bigint => lineas.reduce((a, l) => a + BigInt(f(l)), 0n);
      expect(BigInt(t.valorBruto)).toBe(suma((l) => l.base));
      expect(BigInt(t.impuestos['01'])).toBe(suma((l) => l.impuestos['01']));
      expect(BigInt(t.impuestos['04'])).toBe(suma((l) => l.impuestos['04']));
      expect(t.impuestos['03']).toBe(0);
      expect(BigInt(t.valorTotal)).toBe(suma((l) => l.total));
      expect(t.valorTotal).toBe(t.valorBruto + t.impuestos['01'] + t.impuestos['04'] + t.impuestos['03']);
      expect(descuadres(lineas, t)).toEqual([]);
      for (const l of lineas) expect(l.total).toBe(l.base + l.impuestos['01'] + l.impuestos['04'] + l.impuestos['03']);
    }
  });

  it('un centavo de más o de menos en cualquier total es un descuadre, en cualquier documento', () => {
    const r = azar(99);
    for (let d = 0; d < 300; d += 1) {
      const lineas = lineasAlAzar(r, 1 + Math.floor(r() * 10));
      const t = totalesDesdeLineas(lineas);
      for (const delta of [1, -1]) {
        if (t.valorBruto + delta >= 0) {
          expect(descuadres(lineas, { ...t, valorBruto: t.valorBruto + delta })).not.toEqual([]);
        }
        if (t.valorTotal + delta >= 0) {
          expect(descuadres(lineas, { ...t, valorTotal: t.valorTotal + delta })).not.toEqual([]);
        }
        for (const codigo of ['01', '04', '03'] as const) {
          if (t.impuestos[codigo] + delta < 0) continue;
          const movido = { ...t, impuestos: { ...t.impuestos, [codigo]: t.impuestos[codigo] + delta } };
          expect(descuadres(lineas, movido)).not.toEqual([]);
          // Tampoco cuadra «compensando» el total: la suma de las líneas manda.
          expect(descuadres(lineas, { ...movido, valorTotal: t.valorTotal + delta })).not.toEqual([]);
        }
      }
    }
  });

  it('redondear por línea y no sobre el total: la suma de impuestos por línea es la que entra al CUFE', () => {
    // 3 líneas de 0,35 al 19 %: 0,0665 → 0,07 cada una = 0,21; sobre el total (1,05) daría 0,20.
    const lineas = [1, 2, 3].map(() => redondearLinea({ base: 0.35, impuestos: { '01': 0.35 * 0.19 } }));
    const t = totalesDesdeLineas(lineas);
    expect(t.impuestos['01']).toBe(21);
    expect(impuestoDeBase(t.valorBruto, 19)).toBe(20);
    expect(descuadres(lineas, { ...t, impuestos: { ...t.impuestos, '01': 20 }, valorTotal: t.valorTotal - 1 })).not.toEqual([]);
  });
});

describe('formatearMontoDian · nunca escribe un monto que no sea dinero', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0.5, 1e21, 2 ** 53, '100' as never, null as never, undefined as never])(
    'rechaza %s',
    (v) => {
      expect(() => formatearMontoDian(v)).toThrow(/centavos enteros/);
    },
  );

  it('-0 se escribe 0.00, sin signo', () => {
    expect(formatearMontoDian(-0)).toBe('0.00');
  });
});
