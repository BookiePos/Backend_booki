import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo patrón que el resto de las pruebas: SWC y los @Prop().
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { InvoiceMatchingService } from './invoice-matching.service';

/**
 * Cuándo un renglón de la factura se empareja SOLO con un producto por nombre.
 *
 * Emparejar mal suma stock al producto equivocado; no emparejar solo cuesta un
 * clic (y la pantalla de revisión sugiere los parecidos). Por eso el criterio
 * es estricto: nombre claramente igual y sin otro candidato igual de bueno.
 */
describe('InvoiceMatchingService · emparejamiento por nombre', () => {
  const catalog = [
    { id: 'coca', sku: 'COCA-ORIG', name: 'Coca cola original' },
    { id: 'postobon', sku: 'POSTO-350', name: 'Gaseosa Postobón 350 ml' },
    { id: 'arroz500', sku: 'ARROZ-500', name: 'Arroz Diana 500 g' },
    { id: 'arroz1000', sku: 'ARROZ-1000', name: 'Arroz Diana 1000 g' },
  ];

  let service: InvoiceMatchingService;

  beforeEach(() => {
    const products = { list: vi.fn().mockResolvedValue(catalog) };
    const aliases = { find: vi.fn(() => ({ exec: async () => [] })) };
    service = new InvoiceMatchingService(
      products as never,
      {} as never,
      aliases as never,
    );
  });

  const match = async (description: string) =>
    (await service.matchLines([{ description, qty: 2, unitCost: 1000 }]))[0];

  it('empareja cuando el nombre es claramente el mismo, aunque lo escriban distinto', async () => {
    const result = await match('GASEOSA POSTOBON 350ML X 12');

    expect(result).toMatchObject({ productId: 'postobon', matchedBy: 'name' });
  });

  it('no empareja solo lo dudoso: lo deja como sugerencia para la persona', async () => {
    const result = await match('Coca cola regular friopack');

    expect(result).toMatchObject({ createProduct: true, matchedBy: 'none' });
    expect(result?.productId).toBeUndefined();
  });

  it('con dos presentaciones igual de parecidas no adivina', async () => {
    const result = await match('ARROZ DIANA');

    expect(result?.productId).toBeUndefined();
  });

  it('si la factura trae la presentación, elige la que coincide', async () => {
    const result = await match('ARROZ DIANA 1000G');

    expect(result).toMatchObject({ productId: 'arroz1000', matchedBy: 'name' });
  });
});
