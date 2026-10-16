import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';

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

import { DeliveryZonesService } from './delivery-zones.service';
import type { SedeScopeUser } from '../../core-auth/domain/sede-access';

/**
 * Ítem 3.10 (auditor de permisos): editar o desactivar una zona de domicilio
 * exige acceso a SU sede, igual que crearla. Antes solo se miraba `sede.manage`
 * y un Gerente de la sede A cambiaba las tarifas de la sede B.
 */
describe('DeliveryZonesService · alcance por sede', () => {
  const sedeA = new Types.ObjectId().toString();
  const sedeB = new Types.ObjectId().toString();
  const gerenteA: SedeScopeUser = {
    role: 'manager',
    permissions: ['sede.manage'],
    sedeIds: [sedeA],
  };
  const dueno: SedeScopeUser = { role: 'owner', permissions: [], sedeIds: [] };

  let zona: { sedeId: Types.ObjectId; fee: number; active: boolean; save: ReturnType<typeof vi.fn> };
  let service: DeliveryZonesService;

  beforeEach(() => {
    zona = { sedeId: new Types.ObjectId(sedeB), fee: 5000, active: true, save: vi.fn() };
    const model = { findById: vi.fn(() => ({ exec: async () => zona })) };
    service = new DeliveryZonesService(model as never);
  });

  const id = new Types.ObjectId().toString();

  it('el Gerente de otra sede no cambia la tarifa', async () => {
    await expect(service.update(id, { fee: 1 }, gerenteA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(zona.fee).toBe(5000);
    expect(zona.save).not.toHaveBeenCalled();
  });

  it('el Gerente de otra sede no la desactiva', async () => {
    await expect(service.deactivate(id, gerenteA)).rejects.toBeInstanceOf(ForbiddenException);
    expect(zona.active).toBe(true);
  });

  it('quien tiene la sede sí la edita', async () => {
    const gerenteB = { ...gerenteA, sedeIds: [sedeB] };
    await service.update(id, { fee: 7000 }, gerenteB);
    expect(zona.fee).toBe(7000);
    await service.deactivate(id, dueno);
    expect(zona.active).toBe(false);
  });
});
