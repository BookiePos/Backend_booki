import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, Types } from 'mongoose';
import { TenantModelRegistry } from '../shared/tenancy/tenant-model.registry';
import { createModelProxy } from '../shared/tenancy/model-proxy';
import { TenantContext, dbNameForBusiness } from '../shared/tenancy/tenant-context';
import {
  INDICE_PAGO_PRESTACION_VIVO,
  PayrollPagoPrestacion,
  PayrollPagoPrestacionSchema,
} from '../modules/payroll/infrastructure/schemas/payroll-pago-prestacion.schema';
import { PagosPrestacionesService } from '../modules/payroll/application/pagos-prestaciones.service';
import { levantarMongod } from './mongo-real';

/**
 * Pago de prima, cesantías e intereses (decisión 2, Fase 8) contra un Mongo
 * real: el índice único parcial deja UN pago vivo por trabajador, prestación y
 * tramo aunque lleguen varios envíos a la vez, y el anulado sale del índice
 * para poder registrar el corregido. Cada empresa en su base.
 */
describe('nómina · un pago de prestaciones vivo por trabajador, prestación y tramo', () => {
  const EMPRESA = 'eeeeeeeeeeeeeeeeeeeeeeee';
  const OTRA = 'ffffffffffffffffffffffff';
  const EMP = new Types.ObjectId().toString();
  const SEDE = new Types.ObjectId();
  let mongod: MongoMemoryServer;
  let root: Connection;
  let registry: TenantModelRegistry;
  let service: PagosPrestacionesService;
  const asentados: string[] = [];
  const reversados: string[] = [];

  const modelo = () => registry.modelFor(PayrollPagoPrestacion.name, PayrollPagoPrestacionSchema as never);
  const en = <T>(empresa: string, fn: () => Promise<T>) =>
    TenantContext.run({ businessId: empresa, dbName: dbNameForBusiness(empresa) }, async () => {
      await modelo().init();
      return fn();
    });
  const coleccion = (empresa = EMPRESA) =>
    root.useDb(dbNameForBusiness(empresa), { useCache: true }).collection('payroll_pagos_prestaciones');
  const owner = { role: 'owner', permissions: [], sedeIds: [], email: 'duena@x.co' };
  const dto = (o: Record<string, unknown> = {}) => ({
    employeeId: EMP,
    tipo: 'prima',
    monto: 750_000,
    periodoDesde: '2026-01-01',
    periodoHasta: '2026-06-30',
    medioPago: '47',
    fechaPago: '2026-06-15',
    ...o,
  });

  beforeAll(async () => {
    mongod = await levantarMongod();
    root = await mongoose.createConnection(mongod.getUri()).asPromise();
    registry = new TenantModelRegistry(root);
    const empleado = { firstName: 'Ana', lastName: 'Ruiz', sedeId: SEDE, contractType: 'indefinido', salaryType: 'ordinario' };
    service = new PagosPrestacionesService(
      createModelProxy(() => modelo()) as never,
      { findById: () => ({ select: () => ({ exec: async () => empleado }) }) } as never,
      { findOne: () => ({ select: () => ({ lean: () => ({ exec: async () => null }) }) }) } as never,
      { findOne: () => ({ select: () => ({ lean: () => ({ exec: async () => null }) }) }) } as never,
      {
        postPagoPrestacion: async (i: { pagoId: string }) => {
          asentados.push(i.pagoId);
          return true;
        },
        reversePagoPrestacion: async (id: string) => {
          reversados.push(id);
        },
      } as never,
    );
  });
  afterAll(async () => {
    await root?.close();
    await mongod?.stop();
  });

  it('el índice único parcial existe', async () => {
    await en(EMPRESA, async () => undefined);
    const idx = (await coleccion().indexes()).find((i) => i.name === INDICE_PAGO_PRESTACION_VIVO);
    expect(idx?.unique).toBe(true);
    expect(idx?.partialFilterExpression).toEqual({ estado: 'registrado' });
  });

  it('20 envíos a la vez del mismo pago dejan uno solo, ninguno falla y todos asientan el mismo origen', async () => {
    const r = await en(EMPRESA, () => Promise.all(Array.from({ length: 20 }, () => service.registrar(dto() as never, owner))));
    const docs = await coleccion().find({ employeeId: EMP, tipo: 'prima' }).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ monto: 750_000, dias: 180, estado: 'registrado', pago: { medio: '47', fecha: '2026-06-15' } });
    expect(new Set(r.map((x) => String(x._id)))).toEqual(new Set([String(docs[0]!._id)]));
    // El libro es idempotente por (pago_prestacion, id): todos piden el mismo origen.
    expect(new Set(asentados)).toEqual(new Set([String(docs[0]!._id)]));
  });

  it('otra empresa no ve ese pago y puede registrar el suyo', async () => {
    expect(await coleccion(OTRA).countDocuments({})).toBe(0);
    await en(OTRA, () => service.registrar(dto() as never, owner));
    expect(await coleccion(OTRA).countDocuments({})).toBe(1);
    expect(await coleccion().countDocuments({})).toBe(1);
  });

  it('anular en paralelo anula una vez; el anulado sale del índice y se registra el corregido', async () => {
    const [vivo] = await coleccion().find({ estado: 'registrado' }).toArray();
    const id = String(vivo!._id);
    const r = await en(EMPRESA, () => Promise.all(Array.from({ length: 10 }, () => service.anular(id, 'monto errado', owner))));
    expect(r.every((x) => x.estado === 'anulado')).toBe(true);
    expect(r.filter((x) => !x.advertencias.join().includes('ya estaba anulado'))).toHaveLength(1);
    expect(reversados.every((x) => x === id)).toBe(true);
    const nuevo = await en(EMPRESA, () => service.registrar(dto({ monto: 800_000 }) as never, owner));
    expect(String(nuevo._id)).not.toBe(id);
    const docs = await coleccion().find({ employeeId: EMP }).sort({ _id: 1 }).toArray();
    expect(docs.map((d) => [d.estado, d.monto])).toEqual([
      ['anulado', 750_000],
      ['registrado', 800_000],
    ]);
  });
});
