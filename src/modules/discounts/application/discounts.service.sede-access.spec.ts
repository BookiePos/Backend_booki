import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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

import { DiscountsService } from './discounts.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Descuentos por sede.
 *
 * El cálculo del descuento sobre la venta vive en el módulo de ventas y ya está
 * cubierto allí. Lo que se protege aquí es el AISLAMIENTO: un descuento
 * pertenece a una sede, y quien solo tiene acceso a la suya no puede leer, crear
 * ni modificar los de otra. Sin esa barrera, un cajero podría crearse un
 * descuento en la sede vecina, o editar el de allá para llevarlo al cien por
 * ciento.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado.
 */
describe('DiscountsService · aislamiento por sede', () => {
  const MI_SEDE = new Types.ObjectId();
  /** Id válido: con uno mal formado el servicio corta en 404 antes de mirar la sede. */
  const ID = new Types.ObjectId().toString();
  const OTRA_SEDE = new Types.ObjectId();

  /** Cajero con acceso a una sola sede. */
  const cajero: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [MI_SEDE.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let model: any;
  let service: DiscountsService;

  function build(doc: any = null) {
    const query: any = {
      sort: vi.fn(() => query),
      exec: vi.fn().mockResolvedValue([]),
    };
    model = {
      find: vi.fn(() => query),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(doc) })),
      create: vi.fn((d: unknown) => Promise.resolve(d)),
    };
    service = new DiscountsService(model as never);
  }

  /** Descuento existente en la sede indicada. */
  function descuento(sedeId: Types.ObjectId) {
    return {
      sedeId,
      name: 'Cliente frecuente',
      type: 'percent',
      value: 10,
      active: true,
      save: vi.fn().mockResolvedValue(undefined),
      deleteOne: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('lectura', () => {
    it('lista los descuentos de su propia sede', async () => {
      build();

      await service.list(MI_SEDE.toString(), cajero);

      expect(model.find.mock.calls[0][0].sedeId.toString()).toBe(
        MI_SEDE.toString(),
      );
    });

    it('no deja listar los de otra sede', async () => {
      build();

      expect(() => service.list(OTRA_SEDE.toString(), cajero)).toThrow(
        ForbiddenException,
      );
      expect(model.find).not.toHaveBeenCalled();
    });

    it('muestra primero los activos, luego por nombre', async () => {
      build();

      await service.list(MI_SEDE.toString(), cajero);

      expect(model.find().sort).toHaveBeenCalledWith({ active: -1, name: 1 });
    });
  });

  describe('creación', () => {
    it('crea en su sede y nace activo por defecto', async () => {
      build();

      await service.create(
        {
          sedeId: MI_SEDE.toString(),
          name: 'Cliente frecuente',
          type: 'percent',
          value: 10,
        } as never,
        cajero,
      );

      expect(model.create.mock.calls[0][0]).toMatchObject({
        name: 'Cliente frecuente',
        active: true,
      });
    });

    it('no deja crear descuentos en otra sede', async () => {
      build();

      expect(() =>
        service.create(
          {
            sedeId: OTRA_SEDE.toString(),
            name: 'Regalado',
            type: 'percent',
            value: 100,
          } as never,
          cajero,
        ),
      ).toThrow(ForbiddenException);
      expect(model.create).not.toHaveBeenCalled();
    });
  });

  describe('edición y borrado', () => {
    it('edita el de su sede y solo los campos enviados', async () => {
      const d = descuento(MI_SEDE);
      build(d);

      await service.update(ID, { value: 15 } as never, cajero);

      expect(d.value).toBe(15);
      expect(d.name).toBe('Cliente frecuente');
      expect(d.save).toHaveBeenCalledOnce();
    });

    it('no deja editar el descuento de otra sede', async () => {
      const ajeno = descuento(OTRA_SEDE);
      build(ajeno);

      await expect(
        service.update(ID, { value: 100 } as never, cajero),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(ajeno.save).not.toHaveBeenCalled();
      expect(ajeno.value).toBe(10);
    });

    it('no deja borrar el descuento de otra sede', async () => {
      const ajeno = descuento(OTRA_SEDE);
      build(ajeno);

      await expect(service.remove(ID, cajero)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(ajeno.deleteOne).not.toHaveBeenCalled();
    });

    it('un descuento inexistente falla claro', async () => {
      build(null);

      await expect(
        service.update(ID, { value: 15 } as never, cajero),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un id con formato inválido no se consulta siquiera', async () => {
      build(null);

      await expect(service.remove('no-es-un-id', cajero)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(model.findById).not.toHaveBeenCalled();
    });
  });

  it('quien ve todas las sedes no queda bloqueado', async () => {
    // El dueño y el administrador no llevan sedes listadas: su permiso de ver
    // todas es lo que los habilita. Si el aislamiento no lo contemplara, no
    // podrían administrar descuentos de ninguna sede.
    const duena: JwtUser = {
      ...cajero,
      role: 'owner',
      sedeIds: [],
      permissions: ['sede.view_all'],
    } as unknown as JwtUser;
    build();

    await service.list(OTRA_SEDE.toString(), duena);

    expect(model.find).toHaveBeenCalledOnce();
  });
});
