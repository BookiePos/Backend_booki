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
 * Cajas (puntos de venta) de la sede para el documento POS (PR 7B): placa,
 * ubicación y tipo de la extensión `PuntoVenta` del anexo DE.
 */
describe('SedesService.update · puntos de venta', () => {
  const id = new Types.ObjectId();

  function build() {
    const sede: any = { _id: id, set: vi.fn((k: string, v: unknown) => (sede[k] = v)), save: vi.fn() };
    const service = new SedesService({
      findById: vi.fn(() => ({ exec: () => Promise.resolve(sede) })),
    } as never);
    return { sede, service };
  }

  it('guarda las cajas limpias y descarta las que no traen placa', async () => {
    const { sede, service } = build();
    await service.update(String(id), {
      puntosVenta: [
        { placa: ' caja-01 ', ubicacion: ' Mostrador ', tipo: 'Caja principal' },
        { placa: '  ', ubicacion: 'x' },
      ],
    } as never);
    expect(sede.set).toHaveBeenCalledWith('puntosVenta', [
      { placa: 'CAJA-01', ubicacion: 'Mostrador', tipo: 'Caja principal' },
    ]);
    expect(sede.save).toHaveBeenCalled();
  });

  it('lista vacía = sin cajas configuradas (se usa la caja por defecto al emitir)', async () => {
    const { sede, service } = build();
    await service.update(String(id), { puntosVenta: [] } as never);
    expect(sede.set).toHaveBeenCalledWith('puntosVenta', []);
  });

  it('sin el campo no toca las cajas', async () => {
    const { sede, service } = build();
    await service.update(String(id), { name: 'Otra' } as never);
    expect(sede.set).not.toHaveBeenCalledWith('puntosVenta', expect.anything());
  });
});
