import { describe, it, expect } from 'vitest';
import { productSimilarity, rankBySimilarity } from './product-similarity';
import { canonicalUnit, mergeProblem } from './product-merge';

/**
 * Cuándo dos nombres son candidatos a ser el mismo producto.
 *
 * El caso que motivó esto: el dueño creó a mano "Coca cola original" y la
 * factura del proveedor dice "Coca cola regular friopack". Con la medida
 * anterior (0,40) ni siquiera se sugería, y cada factura creaba otro producto.
 */
describe('productSimilarity', () => {
  it('sugiere el producto creado a mano cuando la factura lo nombra distinto', () => {
    const score = productSimilarity('Coca cola original', 'Coca cola regular friopack');

    expect(score).toBeGreaterThanOrEqual(0.3);
    // Pero no tanto como para emparejarlo solo: lo decide la persona.
    expect(score).toBeLessThan(0.6);
  });

  it('reconoce el mismo producto con orden, tildes, unidades pegadas y palabras de más', () => {
    expect(
      productSimilarity('Gaseosa Postobón 350 ml', 'GASEOSA POSTOBON 350ML X 12'),
    ).toBeGreaterThanOrEqual(0.9);
    expect(productSimilarity('Harina 500 gr', 'harina 500g')).toBe(1);
    expect(productSimilarity('Aceite 1,5 L', 'ACEITE 1.5LT')).toBe(1);
  });

  it('castiga presentaciones distintas aunque el nombre coincida', () => {
    const score = productSimilarity('Arroz Diana 500 g', 'ARROZ DIANA 1000G');

    expect(score).toBeLessThan(0.6);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  it('da cero a productos que no comparten nada', () => {
    expect(productSimilarity('Harina de trigo', 'Coca cola')).toBe(0);
    expect(productSimilarity('', 'Coca cola')).toBe(0);
  });

  it('ordena por parecido, respeta el mínimo y el límite', () => {
    const catalog = [
      { name: 'Coca cola original' },
      { name: 'Coca cola zero' },
      { name: 'Harina de trigo' },
      { name: 'Coca cola regular friopack 400 ml' },
    ];

    const ranked = rankBySimilarity('Coca cola regular friopack', catalog, (p) => p.name, {
      limit: 2,
    });

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.item.name).toBe('Coca cola regular friopack 400 ml');
    expect(ranked.every((r) => r.item.name !== 'Harina de trigo')).toBe(true);
  });
});

describe('mergeProblem', () => {
  const base = { name: 'Coca cola original', unit: 'und', active: true };

  it('permite fusionar productos de la misma unidad aunque la escriban distinto', () => {
    expect(canonicalUnit('Unidades')).toBe('und');
    expect(canonicalUnit('Gr')).toBe('g');
    expect(mergeProblem(base, { name: 'Coca cola regular', unit: 'Unidad' })).toBeNull();
  });

  it('bloquea unidades distintas: 3 kg más 5 unidades no son 8 de nada', () => {
    expect(mergeProblem(base, { name: 'Coca cola granel', unit: 'kg' })).toMatch(
      /unidades distintas/,
    );
  });

  it('bloquea productos con variantes y los que ya se fusionaron', () => {
    expect(
      mergeProblem(base, { name: 'Camiseta', unit: 'und', variantAxes: [{ name: 'Talla' }] }),
    ).toMatch(/variantes/);
    expect(
      mergeProblem(base, { name: 'Coca vieja', unit: 'und', mergedInto: 'x' }),
    ).toMatch(/ya se había fusionado/);
    expect(
      mergeProblem({ ...base, active: false }, { name: 'Coca', unit: 'und' }),
    ).toMatch(/inactivo/);
  });
});
