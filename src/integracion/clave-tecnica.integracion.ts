import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types, type Model } from 'mongoose';
import {
  Sede,
  SedeSchema,
  type SedeDocument,
} from '../modules/sedes/infrastructure/schemas/sede.schema';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
  type ElectronicDocumentDocument,
} from '../modules/einvoicing/infrastructure/schemas/electronic-document.schema';
import { Counter, type CounterDocument } from '../modules/sales/infrastructure/schemas/counter.schema';
import { SedesService } from '../modules/sedes/application/sedes.service';
import { EinvoicingService } from '../modules/einvoicing/application/einvoicing.service';
import { ClaveTecnicaSinLlaveError } from '../modules/sedes/application/clave-tecnica';
import { SecretoIlegibleError, VARIABLE_LLAVE } from '../shared/crypto/secretos';
import type { JwtUser } from '../modules/core-auth/infrastructure/jwt.strategy';
import { cifrarClaves, contarClaves } from '../datos/cifrar-clave-tecnica';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * La clave técnica de las resoluciones contra un Mongo real: se guarda cifrada,
 * no sale en ninguna consulta ni respuesta, las viejas en claro se siguen
 * leyendo y la migración `2026-11-cifrar-clave-tecnica` las pasa sin perderlas.
 *
 * Las claves de aquí son inventadas; van con un marcador para buscarlas en el
 * JSON de las respuestas.
 */
describe('clave técnica de las resoluciones · cifrada y fuera de las respuestas', () => {
  const EMPRESA = 'c1c1c1c1c1c1c1c1c1c1c1c1';
  const MIGRACION = 'c2c2c2c2c2c2c2c2c2c2c2c2';
  const CLAVE_A = 'CLAVE-PRUEBA-AAAA-1111'; // secretos-ok
  const CLAVE_B = 'CLAVE-PRUEBA-BBBB-2222'; // secretos-ok
  const CLAVE_POS = 'CLAVE-PRUEBA-POS-3333'; // secretos-ok
  const llaveAnterior = process.env[VARIABLE_LLAVE];
  const llave = randomBytes(32).toString('base64');
  let env: Entorno;
  let sedes: Model<SedeDocument>;
  let svc: SedesService;
  let fe: EinvoicingService;
  let audit: { record: ReturnType<typeof vi.fn> };

  const cruda = (empresa: string, id: unknown) =>
    env.baseDe(empresa).collection('sedes').findOne({ _id: new Types.ObjectId(String(id)) });
  const usuario = (sedeId: string) =>
    ({ userId: 'u1', email: 'a@b.co', role: 'owner', permissions: [], sedeIds: [sedeId] }) as unknown as JwtUser;
  const sinLlave = async <T>(fn: () => Promise<T>): Promise<T> => {
    delete process.env[VARIABLE_LLAVE];
    try {
      return await fn();
    } finally {
      process.env[VARIABLE_LLAVE] = llave;
    }
  };

  beforeAll(async () => {
    process.env[VARIABLE_LLAVE] = llave;
    env = await levantarEntorno();
    sedes = env.modelo(Sede.name, SedeSchema);
    const docs = env.modelo<Model<ElectronicDocumentDocument>>(ElectronicDocument.name, ElectronicDocumentSchema);
    const counters = env.modelo<Model<CounterDocument>>(Counter.name, null);
    svc = new SedesService(sedes);
    audit = { record: vi.fn(async () => undefined) };
    fe = new EinvoicingService(docs, counters, {} as never, svc, {} as never, {} as never, audit as never);
  });
  afterAll(async () => {
    await env?.cerrar();
    if (llaveAnterior === undefined) delete process.env[VARIABLE_LLAVE];
    else process.env[VARIABLE_LLAVE] = llaveAnterior;
  });

  it('crear la sede con clave: queda cifrada en la base y no sale en consultas ni en el JSON', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const creada = await svc.create({
        code: 'A1',
        name: 'Centro',
        nit: '900123456-7',
        resolucionFe: { numero: '1876', prefijo: 'FE', rangoDesde: 1, rangoHasta: 100, claveTecnica: CLAVE_A },
      } as never);
      const id = creada.id as string;

      const enBase = await cruda(EMPRESA, id);
      expect(enBase?.resolucionFe).not.toHaveProperty('claveTecnica');
      expect(enBase?.resolucionFe.claveTecnicaCifrada).toMatchObject({ v: 1 });
      expect(enBase?.resolucionFe.tieneClaveTecnica).toBe(true);
      expect(JSON.stringify(enBase)).not.toContain(CLAVE_A);

      // La respuesta de crear, el listado y la lectura normal: ni clave ni cifrado.
      for (const respuesta of [creada, await svc.list(), await svc.findOrFail(id)]) {
        const json = JSON.stringify(respuesta);
        expect(json).not.toContain(CLAVE_A);
        expect(json).not.toContain('claveTecnicaCifrada');
        expect(json).not.toContain('"claveTecnica"');
        expect(json).toContain('"tieneClaveTecnica":true');
      }
      const normal = await svc.findOrFail(id);
      expect(normal.resolucionFe?.claveTecnica).toBeUndefined();
      expect(normal.resolucionFe?.claveTecnicaCifrada).toBeUndefined();
      // `lean` y una consulta directa al modelo tampoco la traen sin pedirla.
      const plana = await sedes.findById(id).lean().exec();
      expect(plana?.resolucionFe).not.toHaveProperty('claveTecnicaCifrada');
      expect(plana?.resolucionFe).not.toHaveProperty('claveTecnica');

      // Aun pidiéndola, el JSON no la lleva; el servidor sí la puede leer.
      const conClaves = await svc.findOrFailConClaves(id);
      expect(conClaves.resolucionFe?.claveTecnicaCifrada).toBeDefined();
      expect(JSON.stringify(conClaves)).not.toContain('claveTecnicaCifrada');
      expect(await svc.leerClaveTecnica(id, 'invoice')).toBe(CLAVE_A);
    });
  });

  it('editar la sede: sin clave se conserva, con clave nueva se reemplaza, y otro campo no la toca', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const id = (await sedes.findOne({ code: 'A1' }).exec())!.id as string;
      // Lo que manda hoy la ficha de la sede cuando no se toca la clave.
      const r1 = await svc.update(id, { resolucionFe: { numero: '1876', prefijo: 'FE', rangoDesde: 1, rangoHasta: 200 } } as never);
      expect(JSON.stringify(r1)).not.toContain(CLAVE_A);
      expect((await cruda(EMPRESA, id))?.resolucionFe.rangoHasta).toBe(200);
      expect(await svc.leerClaveTecnica(id, 'invoice')).toBe(CLAVE_A);

      await svc.update(id, { name: 'Centro 2' } as never);
      expect(await svc.leerClaveTecnica(id, 'invoice')).toBe(CLAVE_A);

      await svc.update(id, { resolucionFe: { numero: '1876', prefijo: 'FE', claveTecnica: CLAVE_B } } as never);
      expect(await svc.leerClaveTecnica(id, 'invoice')).toBe(CLAVE_B);
      expect(JSON.stringify(await cruda(EMPRESA, id))).not.toContain(CLAVE_B);
    });
  });

  it('sin llave: escribir una clave lanza y no cambia nada; leer la cifrada también lanza', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const id = (await sedes.findOne({ code: 'A1' }).exec())!.id as string;
      const antes = await cruda(EMPRESA, id);
      await sinLlave(async () => {
        await expect(
          svc.update(id, { resolucionFe: { numero: '1', claveTecnica: 'OTRA-CLAVE-PRUEBA' } } as never),
        ).rejects.toThrow(VARIABLE_LLAVE);
        await expect(svc.leerClaveTecnica(id, 'invoice')).rejects.toBeInstanceOf(ClaveTecnicaSinLlaveError);
      });
      expect(await cruda(EMPRESA, id)).toEqual(antes);
    });
  });

  it('registrar resoluciones (factura, POS, nota): cifradas, sin perder las demás, y nada en la respuesta ni en la auditoría', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const id = (await sedes.findOne({ code: 'A1' }).exec())!.id as string;
      const user = usuario(id);
      const base = { rangoDesde: 1, rangoHasta: 500, vigenciaHasta: '2099-12-31' };
      const r1 = await fe.registerResolution(id, { ...base, tipoDocumento: 'pos', numero: '77', prefijo: 'POS', claveTecnica: CLAVE_POS }, user);
      // Otro tipo reescribe el arreglo entero: la del POS no se puede perder.
      const r2 = await fe.registerResolution(id, { ...base, tipoDocumento: 'credit_note', numero: '78', prefijo: 'NC' }, user);
      // Renovar la factura sin teclear la clave conserva la que había.
      const r3 = await fe.registerResolution(id, { ...base, numero: '1877', prefijo: 'FE' }, user);

      expect(await svc.leerClaveTecnica(id, 'pos')).toBe(CLAVE_POS);
      expect(await svc.leerClaveTecnica(id, 'credit_note')).toBeUndefined();
      expect(await svc.leerClaveTecnica(id, 'invoice')).toBe(CLAVE_B);

      const enBase = await cruda(EMPRESA, id);
      const pos = enBase?.resolucionesFe.find((r: { tipoDocumento: string }) => r.tipoDocumento === 'pos');
      expect(pos).not.toHaveProperty('claveTecnica');
      expect(pos.tieneClaveTecnica).toBe(true);

      const salida = JSON.stringify([r1, r2, r3, await fe.resolutionStatus(user), audit.record.mock.calls]);
      for (const secreto of [CLAVE_A, CLAVE_B, CLAVE_POS, 'claveTecnicaCifrada', pos.claveTecnicaCifrada.data]) {
        expect(salida).not.toContain(secreto);
      }
      const [fila] = await fe.resolutionStatus(user);
      expect(fila!.status.claveTecnicaOk).toBe(true);
      expect(fila!.otras.find((o) => o.tipoDocumento === 'pos')!.status.claveTecnicaOk).toBe(true);
      expect(fila!.otras.find((o) => o.tipoDocumento === 'credit_note')!.status.claveTecnicaOk).toBe(false);
    });
  });

  it('la clave cifrada copiada a otra sede o a otro tipo deja de descifrar', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const origen = await svc.findOrFailConClaves((await sedes.findOne({ code: 'A1' }).exec())!.id as string);
      const copia = origen.toObject().resolucionFe!.claveTecnicaCifrada;
      const otra = await svc.create({ code: 'A2', name: 'Norte' } as never);
      await env
        .baseDe(EMPRESA)
        .collection('sedes')
        .updateOne(
          { _id: otra._id },
          { $set: { resolucionFe: { numero: '9', claveTecnicaCifrada: copia }, resolucionesFe: [] } },
        );
      await expect(svc.leerClaveTecnica(otra.id as string, 'invoice')).rejects.toBeInstanceOf(SecretoIlegibleError);

      await env
        .baseDe(EMPRESA)
        .collection('sedes')
        .updateOne(
          { _id: origen._id },
          { $push: { resolucionesFe: { tipoDocumento: 'debit_note', prefijo: 'ND', claveTecnicaCifrada: copia } } as never },
        );
      await expect(svc.leerClaveTecnica(origen.id as string, 'debit_note')).rejects.toBeInstanceOf(SecretoIlegibleError);
    });
  });

  describe('resoluciones anteriores al cifrado (clave en claro) y su migración', () => {
    let vieja: Types.ObjectId;
    let sinNada: Types.ObjectId;

    beforeAll(async () => {
      vieja = new Types.ObjectId();
      sinNada = new Types.ObjectId();
      // Tal como las dejó el código anterior: la clave en claro y sin marca.
      await env
        .baseDe(MIGRACION)
        .collection('sedes')
        .insertMany([
          {
            _id: vieja,
            code: 'V1',
            name: 'Vieja',
            nit: '900123456-7',
            active: true,
            resolucionFe: { numero: '1', prefijo: 'FE', rangoDesde: 1, rangoHasta: 100, claveTecnica: CLAVE_A },
            resolucionesFe: [
              { tipoDocumento: 'pos', prefijo: 'POS', rangoDesde: 1, rangoHasta: 100, claveTecnica: CLAVE_POS },
              { tipoDocumento: 'credit_note', prefijo: 'NC', rangoDesde: 1, rangoHasta: 100 },
              { tipoDocumento: 'contingency', prefijo: 'CT', rangoDesde: 1, rangoHasta: 100, claveTecnica: '' },
            ],
          },
          { _id: sinNada, code: 'V2', name: 'Sin resolución', active: true },
        ]);
    });

    it('la clave en claro se sigue leyendo (emisión), cuenta para el estado y no sale en respuestas', async () => {
      await env.enEmpresa(MIGRACION, async () => {
        const id = vieja.toString();
        expect(await svc.leerClaveTecnica(id, 'invoice')).toBe(CLAVE_A);
        expect(await svc.leerClaveTecnica(id, 'pos')).toBe(CLAVE_POS);
        expect(await svc.leerClaveTecnica(id, 'contingency')).toBeUndefined();
        expect(await svc.leerClaveTecnica(sinNada.toString(), 'invoice')).toBeUndefined();

        const user = usuario(id);
        const estado = await fe.resolutionStatus(user);
        expect(estado[0]!.status.claveTecnicaOk).toBe(true);
        const json = JSON.stringify([await svc.list(), await svc.findOrFailConClaves(id), estado]);
        expect(json).not.toContain(CLAVE_A);
        expect(json).not.toContain(CLAVE_POS);
        expect((await svc.findOrFail(id)).resolucionFe?.claveTecnica).toBeUndefined();
      });
    });

    it('en seco cuenta y no escribe', async () => {
      await env.enEmpresa(MIGRACION, async () => {
        const antes = await cruda(MIGRACION, vieja);
        expect(await contarClaves(sedes)).toEqual({ sedes: 2, clavesEnClaro: 3, clavesCifradas: 0, sinMarca: 2 });
        expect(await cruda(MIGRACION, vieja)).toEqual(antes);
      });
    });

    it('sin llave, aplicar falla y no escribe nada', async () => {
      await env.enEmpresa(MIGRACION, async () => {
        const antes = await cruda(MIGRACION, vieja);
        await sinLlave(() => expect(cifrarClaves(sedes)).rejects.toThrow(VARIABLE_LLAVE));
        expect(await cruda(MIGRACION, vieja)).toEqual(antes);
      });
    });

    it('aplicar cifra, borra el claro y es idempotente', async () => {
      await env.enEmpresa(MIGRACION, async () => {
        expect(await cifrarClaves(sedes)).toEqual({ cifradas: 2, soloLimpiadas: 1 });
        expect(await contarClaves(sedes)).toEqual({ sedes: 2, clavesEnClaro: 0, clavesCifradas: 2, sinMarca: 0 });

        const enBase = await cruda(MIGRACION, vieja);
        const json = JSON.stringify(enBase);
        expect(json).not.toContain(CLAVE_A);
        expect(json).not.toContain(CLAVE_POS);
        expect(json).not.toContain('"claveTecnica"');
        expect(enBase?.resolucionFe.tieneClaveTecnica).toBe(true);
        // Lo demás de cada resolución queda como estaba.
        expect(enBase?.resolucionFe).toMatchObject({ numero: '1', prefijo: 'FE', rangoDesde: 1, rangoHasta: 100 });
        expect(enBase?.resolucionesFe.map((r: { prefijo: string }) => r.prefijo)).toEqual(['POS', 'NC', 'CT']);

        // La emisión lee la misma clave que antes de migrar.
        expect(await svc.leerClaveTecnica(vieja.toString(), 'invoice')).toBe(CLAVE_A);
        expect(await svc.leerClaveTecnica(vieja.toString(), 'pos')).toBe(CLAVE_POS);
        expect(await svc.leerClaveTecnica(vieja.toString(), 'contingency')).toBeUndefined();

        // Segunda corrida: nada que hacer y el documento no cambia (ni el IV).
        expect(await cifrarClaves(sedes)).toEqual({ cifradas: 0, soloLimpiadas: 0 });
        expect(await cruda(MIGRACION, vieja)).toEqual(enBase);
        expect(await cruda(MIGRACION, sinNada)).not.toHaveProperty('resolucionFe');
      });
    });

    it('si la resolución cambió entre la lectura y la escritura, no se pisa', async () => {
      await env.enEmpresa(MIGRACION, async () => {
        const id = new Types.ObjectId();
        await env
          .baseDe(MIGRACION)
          .collection('sedes')
          .insertOne({ _id: id, code: 'V3', name: 'Carrera', active: true, resolucionFe: { numero: '5', claveTecnica: CLAVE_A } });
        // Entre el `find` y el `updateOne` alguien teclea otra clave.
        const conCarrera = {
          find: (f: never) => sedes.find(f),
          updateOne: (f: never, u: never) => ({
            exec: async () => {
              await env.baseDe(MIGRACION).collection('sedes').updateOne({ _id: id }, { $set: { 'resolucionFe.claveTecnica': CLAVE_B } });
              return sedes.updateOne(f, u).exec();
            },
          }),
        } as unknown as Model<SedeDocument>;
        expect(await cifrarClaves(conCarrera)).toEqual({ cifradas: 0, soloLimpiadas: 0 });
        expect(await svc.leerClaveTecnica(id.toString(), 'invoice')).toBe(CLAVE_B);
        // La corrida siguiente la recoge.
        expect(await cifrarClaves(sedes)).toEqual({ cifradas: 1, soloLimpiadas: 0 });
        expect(await svc.leerClaveTecnica(id.toString(), 'invoice')).toBe(CLAVE_B);
      });
    });
  });
});
