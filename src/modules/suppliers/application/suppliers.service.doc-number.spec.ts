import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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

import { SuppliersService } from './suppliers.service';

/**
 * Reconocimiento del proveedor por su documento.
 *
 * Lo usa la carga de facturas por foto: del NIT impreso tiene que salir el
 * proveedor que ya está en la base. El mismo número se escribe de mil formas
 * —con puntos, con guion, con dígito de verificación o sin él— así que la
 * comparación va sobre los dígitos, no sobre el texto.
 *
 * Si no reconociera al proveedor, cada factura crearía uno nuevo: el histórico
 * de compras se parte en varias fichas y los precios que se comparan dejan de
 * ser del mismo tercero.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado.
 */
describe('SuppliersService.findByDocNumber', () => {
  let supplierModel: any;
  let service: SuppliersService;

  /** Proveedores en la base, con el documento tal cual se guardó. */
  function build(guardados: { docNumber: string }[], doc: any = null) {
    supplierModel = {
      find: vi.fn(() => ({ exec: () => Promise.resolve(guardados) })),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(doc) })),
      create: vi.fn((d: unknown) => Promise.resolve(d)),
    };
    service = new SuppliersService(supplierModel as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconoce el mismo NIT escrito con puntos y guion', async () => {
    build([{ docNumber: '900123456' }]);

    const s = await service.findByDocNumber('NIT' as never, '900.123.456-7');

    expect(s).not.toBeNull();
  });

  it('reconoce el guardado con formato cuando llega limpio', async () => {
    build([{ docNumber: '900.123.456-7' }]);

    const s = await service.findByDocNumber('NIT' as never, '900123456');

    expect(s).not.toBeNull();
  });

  it('ignora los espacios sobrantes', async () => {
    build([{ docNumber: '900123456' }]);

    const s = await service.findByDocNumber('NIT' as never, '  900123456  ');

    expect(s).not.toBeNull();
  });

  it('no confunde a dos proveedores distintos', async () => {
    build([{ docNumber: '900123456' }]);

    const s = await service.findByDocNumber('NIT' as never, '901999888-1');

    expect(s).toBeNull();
  });

  it('un documento vacío no devuelve el primero que encuentre', async () => {
    build([{ docNumber: '900123456' }]);

    const s = await service.findByDocNumber('NIT' as never, '   ');

    expect(s).toBeNull();
    expect(supplierModel.find).not.toHaveBeenCalled();
  });

  it('un documento sin dígitos tampoco', async () => {
    build([{ docNumber: '900123456' }]);

    const s = await service.findByDocNumber('NIT' as never, 'SIN-NIT');

    expect(s).toBeNull();
  });

  it('busca solo dentro del mismo tipo de documento', async () => {
    build([{ docNumber: '900123456' }]);

    await service.findByDocNumber('CC' as never, '900123456');

    expect(supplierModel.find).toHaveBeenCalledWith({ docType: 'CC' });
  });

  it('sin proveedores cargados devuelve nulo, no revienta', async () => {
    build([]);

    const s = await service.findByDocNumber('NIT' as never, '900123456');

    expect(s).toBeNull();
  });

  describe('alta y estado', () => {
    it('un documento repetido da un error claro', async () => {
      build([]);
      supplierModel.create.mockRejectedValue({ code: 11000 });

      await expect(
        service.create({ name: 'Distribuidora', docNumber: '900123456' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('desactivar conserva la ficha en vez de borrarla', async () => {
      // El histórico de compras apunta al proveedor: borrarlo dejaría huérfanas
      // las facturas ya cargadas.
      const proveedor = {
        active: true,
        save: vi.fn().mockResolvedValue(undefined),
      };
      build([], proveedor);

      await service.setStatus(new Types.ObjectId().toString(), false);

      expect(proveedor.active).toBe(false);
      expect(proveedor.save).toHaveBeenCalledOnce();
    });

    it('un proveedor inexistente falla claro', async () => {
      build([], null);

      await expect(
        service.getOrFail(new Types.ObjectId().toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
