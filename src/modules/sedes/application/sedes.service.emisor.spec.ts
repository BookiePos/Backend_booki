import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
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
import { EmisorDeSedeService } from './emisor-de-sede.service';

type Fila = Record<string, any>;

/**
 * Editar los datos fiscales de la sede mantiene al día su emisor fiscal, con
 * las reglas de la migración `2026-10-emisores-desde-sedes`: nunca se elige
 * entre datos distintos del mismo NIT.
 */
describe('SedesService.update · sincroniza el emisor fiscal', () => {
  let sedes: Fila[];
  let emisores: Fila[];
  let service: SedesService;

  const nuevaSede = (cambios: Fila = {}): Fila => {
    const s: Fila = {
      _id: new Types.ObjectId(),
      code: 'A',
      name: 'Centro',
      businessName: 'Crunchy S.A.S.',
      nit: '900.123.456-7',
      nitDv: '7',
      tipoPersona: 'juridica',
      responsableIva: false,
      address: 'Calle 1',
      set: vi.fn(),
      ...cambios,
    };
    s.save = vi.fn(async () => undefined);
    sedes.push(s);
    return s;
  };
  const nuevoEmisor = (cambios: Fila = {}): Fila => {
    const e: Fila = {
      _id: new Types.ObjectId(),
      razonSocial: 'Crunchy S.A.S.',
      nit: '900.123.456-7',
      nitNorm: '900123456',
      nitDv: '7',
      tipoPersona: 'juridica',
      responsableIva: false,
      direccion: 'Calle 1',
      habilitado: true,
      facturaSoftwareId: 'sw-1',
      ...cambios,
    };
    e.id = String(e._id);
    emisores.push(e);
    return e;
  };
  const guardar = (s: Fila, dto: Fila) => service.update(String(s._id), dto as never);

  beforeEach(() => {
    sedes = [];
    emisores = [];
    const sedeModel = {
      findById: (id: unknown) => ({ exec: async () => sedes.find((s) => String(s._id) === String(id)) ?? null }),
      find: (f: Fila) => {
        const q: any = {
          select: () => q,
          lean: () => q,
          exec: async () => sedes.filter((s) => String(s._id) !== String(f._id.$ne) && s.nit),
        };
        return q;
      },
    };
    const emisorModel = {
      findById: (id: unknown) => ({ exec: async () => emisores.find((e) => String(e._id) === String(id)) ?? null }),
      findOne: (f: Fila) => ({ exec: async () => emisores.find((e) => e.nitNorm === f.nitNorm) ?? null }),
      // Lo creado lleva SOLO lo que se le pasa: ni habilitado ni credenciales.
      create: vi.fn(async (d: Fila) => {
        const e: Fila = { _id: new Types.ObjectId(), ...d };
        e.id = String(e._id);
        emisores.push(e);
        return e;
      }),
      updateOne: vi.fn((f: Fila, u: Fila) => ({
        exec: async () => {
          const e = emisores.find((x) => String(x._id) === String(f._id) && x.nitNorm === f.nitNorm);
          if (!e) return;
          Object.assign(e, u.$set ?? {});
          for (const k of Object.keys(u.$unset ?? {})) delete e[k];
        },
      })),
    };
    service = new SedesService(sedeModel as never, new EmisorDeSedeService(sedeModel as never, emisorModel as never));
    (service as any).emisorModel = emisorModel;
  });
  const modeloEmisor = () => (service as any).emisorModel as { create: any; updateOne: any };

  it('una sola sede del NIT: la razón social, las responsabilidades y el contacto pasan al emisor', async () => {
    const e = nuevoEmisor();
    const s = nuevaSede({ emisorId: e._id });
    await guardar(s, { businessName: 'Crunchy Munch S.A.S.', responsableIva: true, address: '', nitDv: '7' });
    expect(e).toMatchObject({ razonSocial: 'Crunchy Munch S.A.S.', responsableIva: true, nitDv: '7' });
    expect(e.direccion).toBeUndefined();
    // No toca la configuración de factura electrónica del emisor.
    expect(e).toMatchObject({ habilitado: true, facturaSoftwareId: 'sw-1', nitNorm: '900123456' });
    expect(s.save).toHaveBeenCalledTimes(1);
  });

  it('una edición que no toca datos fiscales no consulta ni escribe el emisor', async () => {
    const e = nuevoEmisor({ razonSocial: 'Viejo nombre' });
    const s = nuevaSede({ emisorId: e._id });
    await guardar(s, { legalNote: 'Gracias por su compra' });
    expect(e.razonSocial).toBe('Viejo nombre');
    expect(modeloEmisor().updateOne).not.toHaveBeenCalled();
  });

  it('dos sedes del mismo NIT: el cambio se aplaza hasta que las dos coinciden (sin 409: no habría cómo cambiarlo)', async () => {
    const e = nuevoEmisor();
    const a = nuevaSede({ emisorId: e._id });
    const b = nuevaSede({ code: 'B', name: 'Norte', emisorId: e._id, address: 'Carrera 9' });
    await guardar(a, { businessName: 'Crunchy Munch S.A.S.' });
    expect(a.businessName).toBe('Crunchy Munch S.A.S.');
    expect(e.razonSocial).toBe('Crunchy S.A.S.');
    await guardar(b, { businessName: 'Crunchy Munch S.A.S.' });
    expect(e.razonSocial).toBe('Crunchy Munch S.A.S.');
    // El contacto en el que no coinciden no se pisa con el de una sede cualquiera.
    expect(e.direccion).toBe('Calle 1');
  });

  it('cambia el NIT a uno con emisor que coincide: enlaza la sede y no sobrescribe ese emisor', async () => {
    const viejo = nuevoEmisor();
    const otro = nuevoEmisor({ nit: '800999111', nitNorm: '800999111', nitDv: '2', direccion: 'Av. 80' });
    const s = nuevaSede({ emisorId: viejo._id });
    await guardar(s, { nit: '800.999.111-2', nitDv: '2' });
    expect(String(s.emisorId)).toBe(String(otro._id));
    expect(otro).toMatchObject({ nit: '800999111', direccion: 'Av. 80' });
    expect(viejo.nitNorm).toBe('900123456');
    expect(modeloEmisor().create).not.toHaveBeenCalled();
    expect(modeloEmisor().updateOne).not.toHaveBeenCalled();
  });

  it('cambia el NIT a uno con emisor de otra razón social: 409 claro y la sede no se guarda', async () => {
    const viejo = nuevoEmisor();
    nuevoEmisor({ nit: '800999111', nitNorm: '800999111', nitDv: '2', razonSocial: 'Otra Empresa S.A.' });
    const s = nuevaSede({ emisorId: viejo._id });
    const intento = guardar(s, { nit: '800999111', nitDv: '2' });
    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(/\*\*\*9111.*razón social/);
    expect(s.save).not.toHaveBeenCalled();
    expect(String(s.emisorId)).toBe(String(viejo._id));
  });

  it('cambia el NIT a uno sin emisor: lo crea con los datos de la sede, sin configuración, y la enlaza', async () => {
    const viejo = nuevoEmisor();
    const s = nuevaSede({ emisorId: viejo._id });
    await guardar(s, { nit: '800999111', nitDv: '2', businessName: 'Nueva S.A.S.' });
    const creado = emisores.find((e) => e.nitNorm === '800999111')!;
    expect(creado).toMatchObject({ razonSocial: 'Nueva S.A.S.', nitDv: '2', nit: '800999111' });
    expect(creado.habilitado).toBeUndefined();
    expect(creado.facturaSoftwareId).toBeUndefined();
    expect(String(s.emisorId)).toBe(String(creado._id));
    // El emisor del NIT anterior queda como estaba.
    expect(viejo).toMatchObject({ razonSocial: 'Crunchy S.A.S.', habilitado: true });
  });

  it('cambia el NIT a uno sin emisor que ya usa otra sede con datos distintos: 409 con el nombre de esa sede', async () => {
    const viejo = nuevoEmisor();
    nuevaSede({ code: 'B', name: 'Norte', nit: '800999111', nitDv: '2', businessName: 'Otra Empresa S.A.' });
    const s = nuevaSede({ emisorId: viejo._id });
    const intento = guardar(s, { nit: '800999111', nitDv: '2' });
    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(/Norte.*razón social/);
    expect(modeloEmisor().create).not.toHaveBeenCalled();
    expect(s.save).not.toHaveBeenCalled();
  });

  it('sede con NIT pero sin emisor, sin cambiar el NIT: guardar crea el emisor y la enlaza (sin configuración)', async () => {
    const s = nuevaSede();
    await guardar(s, { businessName: 'Crunchy Munch S.A.S.' });
    const creado = emisores.find((e) => e.nitNorm === '900123456')!;
    expect(creado).toMatchObject({ razonSocial: 'Crunchy Munch S.A.S.', nitDv: '7' });
    expect(creado.habilitado).toBeUndefined();
    expect(creado.facturaSoftwareId).toBeUndefined();
    expect(String(s.emisorId)).toBe(String(creado._id));
    expect(s.save).toHaveBeenCalledTimes(1);
  });

  it('sede con NIT pero sin emisor y ya existe el emisor de ese NIT que coincide: solo la enlaza', async () => {
    const e = nuevoEmisor();
    const s = nuevaSede();
    await guardar(s, { address: 'Calle 1' });
    expect(String(s.emisorId)).toBe(String(e._id));
    expect(modeloEmisor().create).not.toHaveBeenCalled();
  });

  it('sede con NIT pero sin emisor y otra sede del NIT discrepa: guarda sin 409 y sin emisor, y al igualarlas se crea', async () => {
    const b = nuevaSede({ code: 'B', name: 'Norte', businessName: 'Crunchy Munch S.A.S.', nitDv: '3' });
    const a = nuevaSede();
    // Igualar A con B aún deja el DV distinto: no hay emisor, pero tampoco 409.
    await guardar(a, { businessName: 'Crunchy Munch S.A.S.' });
    expect(a.save).toHaveBeenCalledTimes(1);
    expect(a.emisorId).toBeUndefined();
    expect(modeloEmisor().create).not.toHaveBeenCalled();
    // La última que faltaba se iguala: ahora sí nace el emisor.
    await guardar(b, { nitDv: '7' });
    const creado = emisores.find((e) => e.nitNorm === '900123456')!;
    expect(creado).toMatchObject({ razonSocial: 'Crunchy Munch S.A.S.', nitDv: '7' });
    expect(String(b.emisorId)).toBe(String(creado._id));
  });

  it('sede con NIT pero sin emisor y el emisor de ese NIT tiene otra razón social: guarda sin 409 y no la enlaza', async () => {
    nuevoEmisor({ razonSocial: 'Otra Empresa S.A.' });
    const s = nuevaSede();
    await guardar(s, { address: 'Calle 1' });
    expect(s.save).toHaveBeenCalledTimes(1);
    expect(s.emisorId).toBeUndefined();
  });

  it('el municipio DANE sale del departamento y la ciudad de la sede', async () => {
    const s = nuevaSede();
    await guardar(s, { departamento: 'Antioquia', ciudad: 'Rionegro' });
    const creado = emisores.find((e) => e.nitNorm === '900123456')!;
    expect(creado).toMatchObject({ municipioDane: '05615', ciudad: 'Rionegro' });
  });

  it('con el domicilio fijado a mano en el emisor, editar la sede no lo pisa (sí la identidad)', async () => {
    const e = nuevoEmisor({ direccion: 'Dirección del RUT', municipioDane: '05440', domicilioManual: true });
    const s = nuevaSede({ emisorId: e._id });
    await guardar(s, { address: 'Otra calle', departamento: 'Antioquia', ciudad: 'Rionegro', businessName: 'Crunchy Munch S.A.S.' });
    expect(e).toMatchObject({ direccion: 'Dirección del RUT', municipioDane: '05440', razonSocial: 'Crunchy Munch S.A.S.' });
  });

  it('reescribir el NIT con otro formato no cambia de emisor', async () => {
    const e = nuevoEmisor();
    const s = nuevaSede({ emisorId: e._id });
    await guardar(s, { nit: '900123456-7' });
    expect(String(s.emisorId)).toBe(String(e._id));
    expect(e).toMatchObject({ nit: '900123456-7', nitNorm: '900123456' });
    expect(modeloEmisor().create).not.toHaveBeenCalled();
  });
});
