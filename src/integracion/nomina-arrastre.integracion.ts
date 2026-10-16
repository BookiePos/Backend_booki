import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, Types } from 'mongoose';
import { TenantModelRegistry } from '../shared/tenancy/tenant-model.registry';
import { createModelProxy } from '../shared/tenancy/model-proxy';
import { TenantContext, dbNameForBusiness } from '../shared/tenancy/tenant-context';
import {
  PayrollDeduction,
  PayrollDeductionSchema,
} from '../modules/payroll/infrastructure/schemas/payroll-deduction.schema';
import { PayrollService } from '../modules/payroll/application/payroll.service';
import { levantarMongod } from './mongo-real';

/**
 * Arrastre del saldo a cargo (ítem 1.9) contra un Mongo real: dos cierres
 * simultáneos de la misma corrida pasan los dos el chequeo de estado; el
 * índice único parcial `arrastre_vivo_unico` deja un solo arrastre vivo por
 * (corrida, empleado), y el anulado sale del índice para que un nuevo cierre
 * pueda crear el vigente.
 */
describe('nómina · un arrastre vivo por corrida y empleado', () => {
  const EMPRESA = 'dddddddddddddddddddddddd';
  let mongod: MongoMemoryServer;
  let root: Connection;
  let registry: TenantModelRegistry;
  let service: PayrollService;

  const modelo = () => registry.modelFor(PayrollDeduction.name, PayrollDeductionSchema as never);
  const enEmpresa = <T>(fn: () => Promise<T>) =>
    TenantContext.run({ businessId: EMPRESA, dbName: dbNameForBusiness(EMPRESA) }, async () => {
      await modelo().init();
      return fn();
    });
  const coleccion = () =>
    root.useDb(dbNameForBusiness(EMPRESA), { useCache: true }).collection('payroll_deductions');

  const corrida = () => ({
    _id: new Types.ObjectId(),
    period: '2026-09',
    status: 'borrador',
    createdByEmail: 'duena@x.co',
    slips: [
      { employeeId: 'e1', employeeName: 'Ana Ruiz', netoPagar: -50_000, otrasDeduccionesDetalle: [] },
      { employeeId: 'e2', employeeName: 'Beto Gil', netoPagar: 900_000, otrasDeduccionesDetalle: [] },
    ],
    save: vi.fn(async () => undefined),
  });

  beforeAll(async () => {
    mongod = await levantarMongod();
    root = await mongoose.createConnection(mongod.getUri()).asPromise();
    registry = new TenantModelRegistry(root);
    const deductions = createModelProxy(() => modelo()) as never;
    service = new PayrollService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      deductions,
      {} as never,
      {} as never,
      { postPayrollRun: async () => undefined } as never,
    );
  });
  afterAll(async () => {
    await root?.close();
    await mongod?.stop();
  });

  const crear = (run: unknown) =>
    (service as unknown as { crearArrastres: (r: unknown) => Promise<void> }).crearArrastres(run);

  it('el índice único parcial existe', async () => {
    await enEmpresa(async () => undefined);
    const idx = (await coleccion().indexes()).find((i) => i.name === 'arrastre_vivo_unico');
    expect(idx?.unique).toBe(true);
    expect(idx?.partialFilterExpression).toEqual({ source: 'arrastre', sourceId: { $type: 'string' } });
  });

  it('20 cierres en paralelo dejan un solo arrastre y ninguno falla', async () => {
    const run = corrida();
    await enEmpresa(() => Promise.all(Array.from({ length: 20 }, () => crear(run))));
    const docs = await coleccion().find({ source: 'arrastre', sourceId: run._id.toString() }).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ employeeId: 'e1', amount: 50_000, status: 'approved' });
  });

  it('closeRun en paralelo sobre la misma corrida no duplica el arrastre', async () => {
    const run = corrida();
    const runs = { findById: () => ({ exec: async () => run }) };
    (service as unknown as { runs: unknown }).runs = runs;
    await enEmpresa(() => Promise.allSettled(Array.from({ length: 10 }, () => service.closeRun(run._id.toString()))));
    expect(await coleccion().countDocuments({ source: 'arrastre', sourceId: run._id.toString() })).toBe(1);
    expect(run.status).toBe('cerrada');
  });

  it('anular y volver a cerrar: el anulado sale del índice y se crea el vigente', async () => {
    const run = corrida();
    await enEmpresa(async () => {
      await crear(run);
      await service.anularArrastresDe(run as never);
      run.slips[0]!.netoPagar = -30_000; // recalculada
      await crear(run);
      await crear(run);
    });
    const id = run._id.toString();
    const vivos = await coleccion().find({ source: 'arrastre', sourceId: id }).toArray();
    const anulados = await coleccion().find({ source: 'arrastre', sourceIdAnulado: id }).toArray();
    expect(vivos.map((d) => [d.status, d.amount])).toEqual([['approved', 30_000]]);
    expect(anulados.map((d) => [d.status, d.amount, d.sourceId])).toEqual([['cancelled', 50_000, undefined]]);
  });
});
