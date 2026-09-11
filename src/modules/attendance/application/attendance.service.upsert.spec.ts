import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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

import { AttendanceService } from './attendance.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Registro de horas desde el POS.
 *
 * De aquí sale la nómina: las horas que se marcan acá son las que después se
 * clasifican en recargos y se pagan. Por eso el registro es de una sola
 * escritura —una hora ya marcada no se cambia desde el punto de venta— y por eso
 * las horas se calculan en el servidor y no se aceptan del cliente.
 *
 * Sin esa regla, cualquiera con acceso a la caja podría reescribir su hora de
 * entrada al final del turno y cobrar horas que no trabajó.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas. El
 * constructor es: (model, editRequests, employees, sedes).
 */
describe('AttendanceService.upsert · registro write-once', () => {
  const SEDE = new Types.ObjectId();
  const EMPLEADO = new Types.ObjectId();

  const user: JwtUser = {
    userId: 'u1',
    email: 'cajero@bookipos.local',
    name: 'Cajero',
    role: 'cashier',
    sedeIds: [SEDE.toString()],
    permissions: [],
  } as unknown as JwtUser;

  let model: any;
  let service: AttendanceService;

  /** Marca ya guardada para ese empleado y día, o `null` si no hay ninguna. */
  function build(existente: Record<string, unknown> | null) {
    model = {
      findOne: vi.fn(() => ({ exec: () => Promise.resolve(existente) })),
      findOneAndUpdate: vi.fn(() => ({
        exec: () => Promise.resolve({ _id: 'rec1' }),
      })),
    };
    service = new AttendanceService(
      model as never,
      {} as never,
      {
        findById: vi.fn(() => ({
          select: () => ({
            exec: () =>
              Promise.resolve({ firstName: 'Ana', lastName: 'Pérez' }),
          }),
        })),
      } as never,
      {} as never,
    );
  }

  /** Campos que se escribirían en la marca. */
  function escrito(): any {
    return model.findOneAndUpdate.mock.calls[0][1].$set;
  }

  const marca = {
    sedeId: SEDE.toString(),
    employeeId: EMPLEADO.toString(),
    workDate: '2026-09-10',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('la primera marca del día guarda la entrada sin horas todavía', async () => {
    build(null);

    await service.upsert({ ...marca, checkIn: '08:00' } as never, user);

    expect(escrito()).toMatchObject({ checkIn: '08:00', hours: 0 });
  });

  it('al marcar la salida calcula las horas del turno', async () => {
    build({ checkIn: '08:00', employeeName: 'Ana Pérez' });

    await service.upsert({ ...marca, checkOut: '17:30' } as never, user);

    expect(escrito()).toMatchObject({
      checkIn: '08:00',
      checkOut: '17:30',
      hours: 9.5,
    });
  });

  it('un turno que cruza la medianoche no da horas negativas', async () => {
    build({ checkIn: '22:00' });

    await service.upsert({ ...marca, checkOut: '06:00' } as never, user);

    expect(escrito().hours).toBe(8);
  });

  it('las horas salen del servidor: redondea a dos decimales', async () => {
    build({ checkIn: '08:00' });

    await service.upsert({ ...marca, checkOut: '16:20' } as never, user);

    expect(escrito().hours).toBe(8.33);
  });

  describe('inmutabilidad', () => {
    it('no deja cambiar una entrada ya marcada', async () => {
      build({ checkIn: '09:15' });

      await expect(
        service.upsert({ ...marca, checkIn: '08:00' } as never, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('no deja cambiar una salida ya marcada', async () => {
      build({ checkIn: '08:00', checkOut: '17:00' });

      await expect(
        service.upsert({ ...marca, checkOut: '19:00' } as never, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('remarcar la misma hora es inocuo: no rechaza ni duplica', async () => {
      build({ checkIn: '08:00' });

      await service.upsert({ ...marca, checkIn: '08:00' } as never, user);

      expect(escrito().checkIn).toBe('08:00');
    });

    it('lo ya guardado manda: una marca nueva solo rellena lo que falta', async () => {
      build({ checkIn: '08:00' });

      await service.upsert(
        { ...marca, checkIn: '08:00', checkOut: '17:00' } as never,
        user,
      );

      expect(escrito()).toMatchObject({ checkIn: '08:00', checkOut: '17:00' });
    });
  });

  it('la marca queda a nombre de quien la registró', async () => {
    build(null);

    await service.upsert({ ...marca, checkIn: '08:00' } as never, user);

    expect(escrito().registeredByEmail).toBe('cajero@bookipos.local');
  });

  it('guarda el nombre del empleado del expediente, no el que llegue', async () => {
    build(null);

    await service.upsert({ ...marca, checkIn: '08:00' } as never, user);

    expect(escrito().employeeName).toBe('Ana Pérez');
  });

  it('un cajero no puede marcar horas en una sede que no es suya', async () => {
    build(null);
    const otraSede = new Types.ObjectId().toString();

    await expect(
      service.upsert(
        { ...marca, sedeId: otraSede, checkIn: '08:00' } as never,
        user,
      ),
    ).rejects.toThrow(/sede/i);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('la marca se identifica por sede, empleado y día', async () => {
    build(null);

    await service.upsert({ ...marca, checkIn: '08:00' } as never, user);

    const filtro = model.findOneAndUpdate.mock.calls[0][0];
    expect(filtro.employeeId).toBe(EMPLEADO.toString());
    expect(filtro.workDate).toBe('2026-09-10');
    expect(filtro.sedeId.toString()).toBe(SEDE.toString());
    // upsert: si es la primera marca del día, se crea.
    expect(model.findOneAndUpdate.mock.calls[0][2]).toMatchObject({
      upsert: true,
    });
  });
});
