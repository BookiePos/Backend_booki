import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
} from '../modules/einvoicing/infrastructure/schemas/electronic-document.schema';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Consecutivo único contra un Mongo real (checklist 1, Fase 1): dos documentos
 * del mismo emisor con el mismo prefijo y número no pueden coexistir. El
 * índice `consecutivo_unico` es lo que lo garantiza aunque dos emisiones
 * corran a la vez.
 */
describe('electronic_documents · consecutivo único (emisor, prefijo, número)', () => {
  const EMPRESA = 'dddddddddddddddddddddddd';
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let env: Entorno;

  const doc = (nit: string | undefined, prefix: string | undefined, number: number, type = 'invoice') => ({
    type,
    sedeId: SEDE,
    prefix,
    number,
    fullNumber: `${prefix ?? ''}${number}`,
    issueDate: '2026-10-28',
    issueTime: '10:00:00-05:00',
    emisor: nit ? { nit } : undefined,
    total: 1000,
    createdByEmail: 'x@y.co',
  });
  const coleccion = () => env.baseDe(EMPRESA).collection('electronic_documents');

  beforeAll(async () => {
    env = await levantarEntorno();
    env.modelo(ElectronicDocument.name, ElectronicDocumentSchema);
  });
  afterAll(async () => {
    await env?.cerrar();
  });

  it('el índice consecutivo_unico existe y es único', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    const indices = await coleccion().indexes();
    expect(indices.find((i) => i.name === 'consecutivo_unico')?.unique).toBe(true);
  });

  it('la misma llave (NIT, prefijo, número) dos veces falla por duplicado', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    await coleccion().insertOne(doc('900123456', 'FE', 1));
    await expect(coleccion().insertOne(doc('900123456', 'FE', 1, 'credit_note'))).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('otro NIT, otro prefijo u otro número no chocan', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    await coleccion().insertOne(doc('900123456', 'FE', 2));
    await coleccion().insertOne(doc('900999999', 'FE', 2));
    await coleccion().insertOne(doc('900123456', 'NC', 2));
    expect(await coleccion().countDocuments({ number: 2 })).toBe(3);
  });

  it('los documentos sin NIT quedan fuera del índice y no se bloquean entre sí', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    await coleccion().insertOne(doc(undefined, 'FE', 9));
    await coleccion().insertOne(doc(undefined, 'FE', 9));
    expect(await coleccion().countDocuments({ number: 9 })).toBe(2);
  });
});
