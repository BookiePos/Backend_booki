import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Model } from 'mongoose';
import {
  FiscalEmitter,
  FiscalEmitterSchema,
  type FiscalEmitterDocument,
} from '../modules/einvoicing/infrastructure/schemas/fiscal-emitter.schema';
import {
  Sede,
  SedeSchema,
  type SedeDocument,
} from '../modules/sedes/infrastructure/schemas/sede.schema';
import { FiscalEmittersService } from '../modules/einvoicing/application/fiscal-emitters.service';
import { VARIABLE_LLAVE } from '../shared/crypto/secretos';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * `fiscal_emitters` contra un Mongo real (checklist 1, Fase 1): un emisor por NIT
 * normalizado en cada empresa (índice único), los secretos fuera de las
 * consultas y del JSON, y dos sedes del mismo NIT compartiendo emisor.
 */
describe('fiscal_emitters · un emisor por NIT y secretos cifrados', () => {
  const EMPRESA = 'eeeeeeeeeeeeeeeeeeeeeeee';
  const OTRA = 'ffffffffffffffffffffffff';
  const llaveAnterior = process.env[VARIABLE_LLAVE];
  let env: Entorno;
  let emisores: Model<FiscalEmitterDocument>;
  let sedes: Model<SedeDocument>;
  let svc: FiscalEmittersService;

  beforeAll(async () => {
    process.env[VARIABLE_LLAVE] = randomBytes(32).toString('base64');
    env = await levantarEntorno();
    emisores = env.modelo(FiscalEmitter.name, FiscalEmitterSchema);
    sedes = env.modelo(Sede.name, SedeSchema);
    svc = new FiscalEmittersService(emisores, sedes);
  });
  afterAll(async () => {
    await env?.cerrar();
    if (llaveAnterior === undefined) delete process.env[VARIABLE_LLAVE];
    else process.env[VARIABLE_LLAVE] = llaveAnterior;
  });

  it('el índice único de nitNorm existe y rechaza un segundo emisor del mismo NIT', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const indices = await env.baseDe(EMPRESA).collection('fiscal_emitters').indexes();
      expect(indices.find((i) => i.name === 'nit_norm_unico')?.unique).toBe(true);
      await emisores.create({ nit: '700.000.001-1', nitNorm: '700000001' });
      await expect(
        emisores.create({ nit: '700000001', nitNorm: '700000001' }),
      ).rejects.toMatchObject({ code: 11000 });
    });
  });

  it('el mismo NIT en otra empresa es otro emisor (una base por empresa)', async () => {
    await env.enEmpresa(OTRA, async () => {
      await emisores.create({ nit: '700000001', nitNorm: '700000001' });
    });
    expect(await env.baseDe(OTRA).collection('fiscal_emitters').countDocuments()).toBe(1);
  });

  it('dos sedes con el mismo NIT comparten emisor; los secretos no salen sin pedirlos', async () => {
    await env.enEmpresa(EMPRESA, async () => {
      const a = await sedes.create({ code: 'S1', name: 'Centro', businessName: 'Crunchy SAS', nit: '900.123.456-7' });
      const b = await sedes.create({ code: 'S2', name: 'Norte', businessName: 'Crunchy SAS', nit: '900123456' });
      const ea = await svc.asegurarParaSede(a.id);
      const eb = await svc.asegurarParaSede(b.id);
      expect(eb.id).toBe(ea.id);
      expect(await emisores.countDocuments({ nitNorm: '900123456' })).toBe(1);
      expect(String((await sedes.findById(b.id))?.emisorId)).toBe(ea.id);

      await svc.guardarCredenciales(ea.id, { facturaSoftwareId: 'sw', facturaPin: 'pin-real' });
      const normal = await emisores.findById(ea.id).exec();
      expect(normal?.get('facturaPin')).toBeUndefined();
      expect(normal?.facturaSoftwareId).toBe('sw');

      const conSecreto = await emisores.findById(ea.id).select('+facturaPin').exec();
      expect(conSecreto?.get('facturaPin')).toBeDefined();
      expect(JSON.stringify(conSecreto)).not.toContain('facturaPin');
      expect(await svc.leerSecreto(ea.id, 'facturaPin')).toBe('pin-real');

      const cruda = await env.baseDe(EMPRESA).collection('fiscal_emitters').findOne({ _id: ea._id });
      expect(JSON.stringify(cruda)).not.toContain('pin-real');

      const estado = await svc.estadoConfiguracion(ea.id);
      expect(estado).toMatchObject({ tienePin: true, softwareId: 'sw', certificadoVigente: false });
      expect(estado.tipoAmbiente).toBe('2');
      expect(estado.habilitado).toBe(false);
    });
  });
});
