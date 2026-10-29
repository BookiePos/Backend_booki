import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ElectronicDocument,
  ElectronicDocumentSchema,
} from '../modules/einvoicing/infrastructure/schemas/electronic-document.schema';
import {
  EXPR_NIT_NORM,
  FILTRO_SIN_NIT_NORM,
  PIPELINE_CONSECUTIVO_DUPLICADO,
} from '../modules/einvoicing/domain/consecutivo-unico';
import { Entorno, levantarEntorno } from './mongo-real';

/**
 * Consecutivo único contra un Mongo real (checklist 1, Fase 1): dos documentos
 * del mismo emisor (NIT normalizado) con el mismo prefijo y número no pueden
 * coexistir, sea cual sea el tipo de documento. El índice `consecutivo_unico`
 * lo garantiza aunque dos emisiones corran a la vez.
 */
describe('electronic_documents · consecutivo único (emisor, prefijo, número)', () => {
  const EMPRESA = 'dddddddddddddddddddddddd';
  const SEDE = '68b0f3c2a1d4e5f6a7b8c9d0';
  let env: Entorno;

  const doc = (
    nitNorm: string | undefined,
    prefix: string | undefined,
    number: number,
    type = 'invoice',
    nit?: string,
  ) => ({
    type,
    sedeId: SEDE,
    prefix,
    number,
    fullNumber: `${prefix ?? ''}${number}`,
    issueDate: '2026-10-28',
    issueTime: '10:00:00-05:00',
    // Sin claves undefined: el driver las guardaría como null y `$exists` ya no las vería.
    ...(nitNorm || nit ? { emisor: { ...(nit ? { nit } : {}), ...(nitNorm ? { nitNorm } : {}) } } : {}),
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
    await expect(coleccion().insertOne(doc('900123456', 'FE', 1))).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('el tipo no entra en la llave: una nota con el mismo prefijo y número también choca', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    await coleccion().insertOne(doc('900123456', 'XX', 7));
    await expect(
      coleccion().insertOne(doc('900123456', 'XX', 7, 'credit_note')),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('otro NIT, otro prefijo u otro número no chocan', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    await coleccion().insertOne(doc('900123456', 'FE', 2));
    await coleccion().insertOne(doc('900999999', 'FE', 2));
    await coleccion().insertOne(doc('900123456', 'NC', 2));
    expect(await coleccion().countDocuments({ number: 2 })).toBe(3);
  });

  it('los documentos sin nitNorm quedan fuera del índice y no se bloquean entre sí', async () => {
    await env.enEmpresa(EMPRESA, async () => undefined);
    await coleccion().insertOne(doc(undefined, 'FE', 9, 'invoice', '900.123.456-7'));
    await coleccion().insertOne(doc(undefined, 'FE', 9, 'invoice', '900.123.456-7'));
    expect(await coleccion().countDocuments({ number: 9 })).toBe(2);
  });

  it('el informe normaliza emisor.nit y encuentra los duplicados de los documentos viejos', async () => {
    const grupos = await coleccion().aggregate(PIPELINE_CONSECUTIVO_DUPLICADO).toArray();
    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toMatchObject({ _id: { nit: '900123456', prefix: 'FE', number: 9 }, n: 2 });
  });

  it('el relleno calcula nitNorm desde emisor.nit y es idempotente', async () => {
    // Con duplicados el relleno fallaría al entrar al índice: por eso el informe va antes.
    await coleccion().deleteMany({ number: 9 });
    await coleccion().insertOne(doc(undefined, 'ZZ', 10, 'invoice', '900.123.456-7'));
    await coleccion().insertOne(doc(undefined, 'ZZ', 11, 'invoice', '900123456'));
    expect(await coleccion().countDocuments(FILTRO_SIN_NIT_NORM)).toBe(2);
    for (let i = 0; i < 2; i++) {
      await coleccion().updateMany({ ...FILTRO_SIN_NIT_NORM }, [{ $set: { 'emisor.nitNorm': EXPR_NIT_NORM } }]);
    }
    expect(await coleccion().countDocuments(FILTRO_SIN_NIT_NORM)).toBe(0);
    expect(await coleccion().countDocuments({ prefix: 'ZZ', 'emisor.nitNorm': '900123456' })).toBe(2);
  });
});
