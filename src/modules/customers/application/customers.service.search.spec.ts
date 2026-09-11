import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';

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

import { CustomersService } from './customers.service';

/**
 * Búsqueda y alta de clientes.
 *
 * Lo delicado no es el CRUD sino el buscador: arma una expresión regular con
 * texto que teclea el usuario. Sin escapar los metacaracteres, una cadena como
 * `(a+)+$` bloquea el hilo del servidor entero y tumba la API para todas las
 * empresas a la vez. Es barato de disparar y difícil de diagnosticar después.
 *
 * Lo segundo es el documento duplicado: dos fichas del mismo cliente parten su
 * cartera en dos y ninguna muestra lo que debe de verdad.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado.
 */
describe('CustomersService', () => {
  let customers: any;
  let service: CustomersService;

  function build(doc: any = null) {
    const query: any = {
      sort: vi.fn(() => query),
      limit: vi.fn(() => query),
      exec: vi.fn().mockResolvedValue([]),
    };
    customers = {
      find: vi.fn(() => query),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(doc) })),
      create: vi.fn((d: unknown) => Promise.resolve(d)),
    };
    service = new CustomersService(customers as never);
  }

  /** Filtro con el que se consultó la colección. */
  function filtro(): any {
    return customers.find.mock.calls[0][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    build();
  });

  describe('búsqueda', () => {
    it('sin texto solo filtra por activos', async () => {
      await service.list({});

      expect(filtro()).toEqual({ active: true });
    });

    it('puede incluir los inactivos cuando se pide', async () => {
      await service.list({ includeInactive: true });

      expect(filtro().active).toBeUndefined();
    });

    it('busca por nombre, documento y teléfono a la vez', async () => {
      await service.list({ search: 'ana' });

      expect(filtro().$or.map((c: any) => Object.keys(c)[0])).toEqual([
        'name',
        'docNumber',
        'phone',
      ]);
    });

    it('la búsqueda no distingue mayúsculas', async () => {
      await service.list({ search: 'ana' });

      expect(filtro().$or[0].name.flags).toContain('i');
    });

    it('escapa los metacaracteres: el texto se busca literal', async () => {
      // Un cliente llamado "Pérez (h)" tiene que encontrarse por su nombre,
      // no interpretarse como un grupo de captura.
      await service.list({ search: 'Pérez (h)' });

      const rx: RegExp = filtro().$or[0].name;
      expect(rx.test('Comercial Pérez (h) SAS')).toBe(true);
      expect(rx.test('Pérez h')).toBe(false);
    });

    it('un patrón que colgaría el servidor se trata como texto plano', async () => {
      // Sin escapar, este patrón dispara retroceso exponencial y bloquea el
      // hilo. Escapado es una cadena literal que no encuentra nada.
      const malicioso = '(a+)+$';
      await service.list({ search: malicioso });

      const rx: RegExp = filtro().$or[0].name;
      const inicio = Date.now();
      expect(rx.test('a'.repeat(40))).toBe(false);
      expect(Date.now() - inicio).toBeLessThan(1_000);
      expect(rx.test(`Cliente ${malicioso}`)).toBe(true);
    });

    it('recorta los espacios sobrantes del texto buscado', async () => {
      await service.list({ search: '  ana  ' });

      expect(filtro().$or[0].name.source).toBe('ana');
    });
  });

  describe('alta', () => {
    it('guarda el cliente recortando los espacios', async () => {
      await service.create({
        name: '  Ana Pérez  ',
        docNumber: ' 1020304050 ',
        phone: ' 3001234567 ',
      } as never);

      expect(customers.create.mock.calls[0][0]).toMatchObject({
        name: 'Ana Pérez',
        docNumber: '1020304050',
        phone: '3001234567',
      });
    });

    it('sin tipo de documento asume cédula', async () => {
      await service.create({ name: 'Ana', docNumber: '1' } as never);

      expect(customers.create.mock.calls[0][0].docType).toBe('CC');
    });

    it('nace activo y sin cupo de crédito', async () => {
      await service.create({ name: 'Ana', docNumber: '1' } as never);

      expect(customers.create.mock.calls[0][0]).toMatchObject({
        active: true,
        creditLimit: 0,
      });
    });

    it('un documento repetido da un error claro, no un fallo de base', async () => {
      build();
      customers.create.mockRejectedValue({ code: 11000 });

      await expect(
        service.create({ name: 'Ana', docNumber: '1020304050' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un fallo distinto de duplicado se propaga tal cual', async () => {
      build();
      customers.create.mockRejectedValue(new Error('sin conexión a la base'));

      await expect(
        service.create({ name: 'Ana', docNumber: '1' } as never),
      ).rejects.toThrow('sin conexión a la base');
    });
  });

  describe('edición', () => {
    it('solo toca los campos enviados', async () => {
      const cliente = {
        name: 'Ana',
        phone: '3001234567',
        creditLimit: 500_000,
        active: true,
        save: vi.fn().mockResolvedValue(undefined),
      };
      build(cliente);

      await service.update('c1', { name: 'Ana María' } as never);

      expect(cliente.name).toBe('Ana María');
      expect(cliente.phone).toBe('3001234567');
      expect(cliente.creditLimit).toBe(500_000);
    });

    it('una cadena vacía limpia el campo', async () => {
      const cliente = {
        phone: '3001234567',
        save: vi.fn().mockResolvedValue(undefined),
      };
      build(cliente);

      await service.update('c1', { phone: '' } as never);

      expect(cliente.phone).toBeUndefined();
    });

    it('un cliente inexistente falla claro', async () => {
      build(null);

      await expect(
        service.update('c1', { name: 'Ana' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
