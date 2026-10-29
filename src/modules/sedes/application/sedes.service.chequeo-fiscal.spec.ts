import { describe, it, expect, vi } from 'vitest';
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

import { SedesService } from './sedes.service';

/**
 * Sede no responsable de INC (art. 512-13 ET): solo un aviso. La venta no
 * cambia; el sistema no tiene el RUT para decidirlo.
 */
describe('SedesService · chequeo fiscal y responsabilidades del RUT', () => {
  const A = new Types.ObjectId();
  const B = new Types.ObjectId();

  function build(sedes: any[], activas: number) {
    const chain = { select: () => chain, sort: () => chain, exec: () => Promise.resolve(sedes) };
    const sedeModel = {
      find: vi.fn(() => chain),
      countDocuments: vi.fn(() => ({ exec: () => Promise.resolve(activas) })),
    };
    return { service: new SedesService(sedeModel as never), sedeModel };
  }

  it('avisa por la sede jurídica marcada no responsable, no por la responsable', async () => {
    const { service, sedeModel } = build(
      [
        { _id: A, name: 'Centro', responsableInc: false, tipoPersona: 'juridica' },
        { _id: B, name: 'Norte', responsableInc: true, tipoPersona: 'juridica' },
      ],
      2,
    );
    const r = await service.chequeoFiscal(null);
    expect(r[0]!.sedeId).toBe(String(A));
    // Jurídica + dos sedes activas.
    expect(r[0]!.advertencias).toHaveLength(2);
    expect(r[1]!.advertencias).toEqual([]);
    // Cuenta las sedes activas de la empresa, no solo las del usuario.
    expect(sedeModel.countDocuments).toHaveBeenCalledWith({ active: { $ne: false } });
  });

  it('respeta el alcance de sedes del usuario', async () => {
    const { service, sedeModel } = build([], 1);
    await service.chequeoFiscal([String(A)]);
    expect(sedeModel.find).toHaveBeenCalledWith({ _id: { $in: [String(A)] } });
  });

  it('editar la sede guarda las responsabilidades del RUT (antes solo al crear)', async () => {
    const sede: any = { _id: A, save: vi.fn().mockResolvedValue(undefined) };
    const service = new SedesService({
      findById: vi.fn(() => ({ exec: () => Promise.resolve(sede) })),
    } as never);
    await service.update(String(A), {
      responsableInc: false,
      responsableIva: true,
      franquicia: false,
      granContribuyente: false,
      regimenRenta: 'ordinario',
    } as never);
    expect(sede).toMatchObject({
      responsableInc: false,
      responsableIva: true,
      franquicia: false,
      granContribuyente: false,
      regimenRenta: 'ordinario',
    });
    expect(sede.save).toHaveBeenCalled();
  });
});
