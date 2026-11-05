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

import { EmployeesService, enmascararCuenta } from './employees.service';

/**
 * Expediente del empleado.
 *
 * Aquí vive el SALARIO, que es el dato del que parte la nómina entera y la
 * liquidación al terminar el contrato. Por eso importa tanto la semántica de la
 * edición parcial: un campo que no viene en el formulario debe quedarse como
 * estaba, y uno que viene vacío debe limpiarse. Si un campo ausente se
 * interpretara como vacío, editar el teléfono borraría el salario.
 *
 * También se guarda el nombre del cargo como copia, para poder listar sin
 * consultar la tabla de cargos. Esa copia tiene que refrescarse al cambiar de
 * cargo, o el listado seguiría mostrando el anterior.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (model, positions).
 */
describe('EmployeesService', () => {
  const CARGO = new Types.ObjectId();

  let model: any;
  let positions: any;
  let service: EmployeesService;

  /** Documento de empleado con lo mínimo para las pruebas. */
  function empleado(over: Record<string, unknown> = {}) {
    return {
      _id: new Types.ObjectId(),
      docType: 'CC',
      docNumber: '1020304050',
      firstName: 'Ana',
      lastName: 'Pérez',
      salary: 2_000_000,
      phone: '3001234567',
      status: 'activo',
      // El cargo y su nombre copiado se declaran para poder comprobarlos.
      positionId: undefined as Types.ObjectId | undefined,
      positionName: undefined as string | undefined,
      save: vi.fn().mockResolvedValue(undefined),
      set: vi.fn(),
      deleteOne: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  function build(existente: any = null) {
    const creado = empleado();
    model = Object.assign(
      function () {
        return creado;
      },
      {
        findById: vi.fn(() => ({ exec: () => Promise.resolve(existente) })),
        find: vi.fn(() => ({
          select: () => ({ sort: () => ({ exec: () => Promise.resolve([]) }) }),
          sort: () => ({ exec: () => Promise.resolve([]) }),
        })),
      },
    );
    positions = {
      findById: vi.fn(() => ({
        select: () => ({ exec: () => Promise.resolve({ name: 'Cajero' }) }),
      })),
    };
    service = new EmployeesService(model as never, positions as never);
    return creado;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('alta', () => {
    it('guarda la identificación y el salario', async () => {
      const emp = build();

      await service.create({
        docType: 'CC',
        docNumber: '1020304050',
        firstName: 'Ana',
        lastName: 'Pérez',
        salary: 2_500_000,
      } as never);

      expect(emp.salary).toBe(2_500_000);
      expect(emp.save).toHaveBeenCalledOnce();
    });

    it('un documento repetido da un error claro, no un fallo de base', async () => {
      const emp = build();
      emp.save.mockRejectedValue({ code: 11000 });

      await expect(
        service.create({
          docNumber: '1020304050',
          firstName: 'Ana',
          lastName: 'Pérez',
        } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un fallo distinto de duplicado se propaga tal cual', async () => {
      const emp = build();
      emp.save.mockRejectedValue(new Error('sin conexión a la base'));

      await expect(
        service.create({ docNumber: '1', firstName: 'A', lastName: 'B' } as never),
      ).rejects.toThrow('sin conexión a la base');
    });
  });

  describe('edición parcial', () => {
    it('lo que no viene en el formulario no se toca', async () => {
      const emp = empleado();
      build(emp);

      await service.update(emp._id.toString(), { phone: '3009999999' } as never);

      expect(emp.phone).toBe('3009999999');
      expect(emp.salary).toBe(2_000_000);
      expect(emp.firstName).toBe('Ana');
    });

    it('un campo enviado vacío sí se limpia', async () => {
      const emp = empleado();
      build(emp);

      await service.update(emp._id.toString(), { phone: '' } as never);

      expect(emp.phone).toBeUndefined();
    });

    it('el salario se puede poner en cero explícitamente', async () => {
      const emp = empleado();
      build(emp);

      await service.update(emp._id.toString(), { salary: 0 } as never);

      expect(emp.salary).toBe(0);
    });

    it('un empleado inexistente falla claro', async () => {
      build(null);

      await expect(
        service.update(new Types.ObjectId().toString(), { phone: '1' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un id con formato inválido no se consulta siquiera', async () => {
      build(null);

      await expect(
        service.update('no-es-un-id', { phone: '1' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(model.findById).not.toHaveBeenCalled();
    });
  });

  describe('copia del nombre del cargo', () => {
    it('al asignar un cargo guarda también su nombre', async () => {
      const emp = empleado();
      build(emp);

      await service.update(emp._id.toString(), {
        positionId: CARGO.toString(),
      } as never);

      expect(emp.positionName).toBe('Cajero');
      expect(String(emp.positionId)).toBe(CARGO.toString());
    });

    it('al quitar el cargo borra también el nombre copiado', async () => {
      const emp = empleado({ positionId: CARGO, positionName: 'Cajero' });
      build(emp);

      await service.update(emp._id.toString(), { positionId: '' } as never);

      expect(emp.positionId).toBeUndefined();
      expect(emp.positionName).toBeUndefined();
    });

    it('un cargo que ya no existe deja el nombre vacío, no el anterior', async () => {
      const emp = empleado({ positionName: 'Cajero' });
      build(emp);
      positions.findById.mockReturnValue({
        select: () => ({ exec: () => Promise.resolve(null) }),
      });

      await service.update(emp._id.toString(), {
        positionId: CARGO.toString(),
      } as never);

      expect(emp.positionName).toBeUndefined();
    });
  });

  describe('campos DIAN de nómina electrónica', () => {
    const dian = {
      secondLastName: 'Gómez',
      otherNames: 'María',
      docTypeDian: '13',
      tipoTrabajador: '01',
      subTipoTrabajador: '00',
      altoRiesgoPension: true,
      tipoContratoDian: '2',
      municipioDaneTrabajo: '05001',
      direccionTrabajo: 'Calle 1 # 2-3',
      medioPago: '47',
    };

    it('un update parcial no borra los demás campos DIAN', async () => {
      const emp = empleado({ ...dian });
      build(emp);

      await service.update(emp._id.toString(), { tipoTrabajador: '02' } as never);

      expect(emp).toMatchObject({ ...dian, tipoTrabajador: '02' });
    });

    it('altoRiesgoPension: false se guarda (no se confunde con ausente)', async () => {
      const emp: any = empleado({ altoRiesgoPension: true });
      build(emp);

      await service.update(emp._id.toString(), { altoRiesgoPension: false } as never);

      expect(emp.altoRiesgoPension).toBe(false);
    });

    it("'' limpia cada campo DIAN en el update", async () => {
      const emp: any = empleado({ ...dian });
      build(emp);

      await service.update(emp._id.toString(), {
        docTypeDian: '',
        tipoTrabajador: '',
        subTipoTrabajador: '',
        tipoContratoDian: '',
        medioPago: '',
        municipioDaneTrabajo: '',
        direccionTrabajo: '',
        secondLastName: '',
        otherNames: '',
      } as never);

      for (const k of Object.keys(dian).filter((k) => k !== 'altoRiesgoPension')) {
        expect(emp[k]).toBeUndefined();
      }
      expect(emp.altoRiesgoPension).toBe(true);
    });

    it("en el alta, '' se trata como ausente", async () => {
      const emp: any = build();

      await service.create({
        docNumber: '1',
        firstName: 'A',
        lastName: 'B',
        docTypeDian: '',
        medioPago: '',
      } as never);

      expect(emp.save).toHaveBeenCalledOnce();
      expect(emp.docTypeDian).toBeUndefined();
      expect(emp.medioPago).toBeUndefined();
    });
  });

  describe('número de cuenta', () => {
    it('enmascara a los últimos 4 dígitos', () => {
      expect(enmascararCuenta('10012345601')).toBe('••••5601');
      expect(enmascararCuenta('')).toBeUndefined();
      expect(enmascararCuenta(undefined)).toBeUndefined();
    });

    it('aVista no expone el número completo y marca tieneCuenta', () => {
      const emp = empleado({ accountNumber: '10012345601' });
      build(emp);

      const v = service.aVista(emp as never);

      expect(v.accountNumber).toBe('••••5601');
      expect(v.tieneCuenta).toBe(true);
      expect(JSON.stringify(v)).not.toContain('10012345601');
      expect(v.salary).toBe(2_000_000);
    });

    it('sin cuenta: tieneCuenta false', () => {
      const emp = empleado();
      build(emp);
      expect(service.aVista(emp as never)).toMatchObject({ tieneCuenta: false });
    });

    it('el servicio sigue entregando el número completo para la nómina', async () => {
      const emp = empleado({ accountNumber: '10012345601' });
      build(emp);
      expect(((await service.getOrFail(emp._id.toString())) as any).accountNumber).toBe('10012345601');
    });

    it('un update que reenvía el valor enmascarado NO pisa el número real', async () => {
      const emp: any = empleado({ accountNumber: '10012345601' });
      build(emp);

      await service.update(emp._id.toString(), { accountNumber: '••••5601', phone: '1' } as never);

      expect(emp.accountNumber).toBe('10012345601');
      expect(emp.phone).toBe('1');
    });

    it('un número nuevo lo reemplaza y "" lo limpia', async () => {
      const emp: any = empleado({ accountNumber: '10012345601' });
      build(emp);
      await service.update(emp._id.toString(), { accountNumber: '999' } as never);
      expect(emp.accountNumber).toBe('999');
      await service.update(emp._id.toString(), { accountNumber: '' } as never);
      expect(emp.accountNumber).toBeUndefined();
    });
  });
});
