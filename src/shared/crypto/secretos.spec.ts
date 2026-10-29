import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Schema, model } from 'mongoose';
import { REDACTADO, redactar } from '../monitoreo/redaccion';
import {
  LlaveInvalidaError,
  SecretoCifradoSchema,
  SecretoIlegibleError,
  VERSION_LLAVE,
  campoSecreto,
  contextoSecreto,
  cifrar,
  descifrar,
  get,
  leerLlave,
  set,
  type SecretoCifrado,
} from './secretos';

const LLAVE_B64 = randomBytes(32).toString('base64');
const env = { EINVOICING_ENCRYPTION_KEY: LLAVE_B64 } as NodeJS.ProcessEnv;
const sinLlave = {} as NodeJS.ProcessEnv;
const CTX = contextoSecreto('66f0aa00bb11cc22dd33ee44', 'claveTecnica');

/** Cambia un byte de un campo base64 sin alterar su longitud. */
function voltearByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = (buf[0] ?? 0) ^ 0x01;
  return buf.toString('base64');
}

describe('secretos: ida y vuelta', () => {
  it('descifra lo que cifra, con tildes y emojis', () => {
    const texto = 'contraseña-del-p12 ñ ✓';
    const s = cifrar(texto, CTX, { env });
    expect(s.v).toBe(VERSION_LLAVE);
    expect(s.data).not.toContain('contraseña');
    expect(descifrar(s, CTX, { env })).toBe(texto);
  });

  it('acepta la llave en hex y en base64url', () => {
    const cruda = randomBytes(32);
    for (const llave of [cruda.toString('hex'), cruda.toString('base64url')]) {
      const e = { EINVOICING_ENCRYPTION_KEY: llave } as NodeJS.ProcessEnv;
      expect(descifrar(cifrar('pin-1234', CTX, { env: e }), CTX, { env: e })).toBe('pin-1234');
    }
  });

  it('los alias set/get cumplen el mismo contrato', () => {
    expect(get(set('clave-tecnica', CTX, { env }), CTX, { env })).toBe('clave-tecnica');
  });

  it('usa un IV distinto en cada cifrado (mismo texto, distinto resultado)', () => {
    const a = cifrar('mismo', CTX, { env });
    const b = cifrar('mismo', CTX, { env });
    expect(Buffer.from(a.iv, 'base64')).toHaveLength(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });
});

describe('secretos: integridad', () => {
  const original = (): SecretoCifrado => cifrar('pin-del-software', CTX, { env });

  it('un dato alterado falla de forma explícita', () => {
    const s = { ...original() };
    s.data = voltearByte(s.data);
    expect(() => descifrar(s, CTX, { env })).toThrow(SecretoIlegibleError);
  });

  it('un tag alterado falla de forma explícita', () => {
    const s = { ...original() };
    s.tag = voltearByte(s.tag);
    expect(() => descifrar(s, CTX, { env })).toThrow(SecretoIlegibleError);
  });

  it('un IV alterado o truncado falla', () => {
    const s = original();
    expect(() => descifrar({ ...s, iv: voltearByte(s.iv) }, CTX, { env })).toThrow(SecretoIlegibleError);
    expect(() => descifrar({ ...s, iv: Buffer.alloc(8).toString('base64') }, CTX, { env })).toThrow(
      SecretoIlegibleError,
    );
  });

  it('un tag truncado se rechaza aunque Node lo aceptaría', () => {
    const s = original();
    const corto = Buffer.from(s.tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => descifrar({ ...s, tag: corto }, CTX, { env })).toThrow('tag de longitud inválida');
  });

  it('una versión de llave desconocida falla', () => {
    expect(() => descifrar({ ...original(), v: 99 }, CTX, { env })).toThrow(SecretoIlegibleError);
  });

  it('otra llave no descifra (y no devuelve basura)', () => {
    const otra = { EINVOICING_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv;
    expect(() => descifrar(original(), CTX, { env: otra })).toThrow(SecretoIlegibleError);
  });

  it('el contexto ata el secreto a su emisor y a su campo', () => {
    const s = cifrar('clave', contextoSecreto('emisorA', 'pin'), { env });
    expect(descifrar(s, contextoSecreto('emisorA', 'pin'), { env })).toBe('clave');
    expect(() => descifrar(s, contextoSecreto('emisorB', 'pin'), { env })).toThrow(SecretoIlegibleError);
    expect(() => descifrar(s, contextoSecreto('emisorA', 'claveTecnica'), { env })).toThrow(
      SecretoIlegibleError,
    );
  });

  it('el contexto es obligatorio y con la forma emisorId:campo', () => {
    for (const malo of ['', 'solo-emisor', 'a:b:c', ':pin', 'emisor:', 'emi sor:pin']) {
      expect(() => cifrar('x', malo, { env }), malo).toThrow('Contexto de secreto inválido');
      expect(() => descifrar(null, malo, { env }), malo).toThrow('Contexto de secreto inválido');
    }
    expect(() => contextoSecreto('', 'pin')).toThrow('Contexto de secreto inválido');
  });

  it('una forma inesperada falla', () => {
    expect(() => descifrar({ iv: 'x' } as unknown as SecretoCifrado, CTX, { env })).toThrow(
      SecretoIlegibleError,
    );
  });
});

describe('secretos: llave faltante o inválida', () => {
  it('sin llave, descifrar/get devuelve null y no lanza', () => {
    const s = cifrar('pin', CTX, { env });
    expect(descifrar(s, CTX, { env: sinLlave })).toBeNull();
    expect(get(s, CTX, { env: { EINVOICING_ENCRYPTION_KEY: '   ' } as NodeJS.ProcessEnv })).toBeNull();
  });

  it('sin valor, descifrar devuelve null', () => {
    expect(descifrar(null, CTX, { env })).toBeNull();
    expect(descifrar(undefined, CTX, { env })).toBeNull();
  });

  it('sin llave, cifrar/set lanza', () => {
    expect(() => cifrar('pin', CTX, { env: sinLlave })).toThrow('EINVOICING_ENCRYPTION_KEY');
    expect(() => set('pin', CTX, { env: sinLlave })).toThrow('EINVOICING_ENCRYPTION_KEY');
  });

  it('una llave de longitud inválida lanza al cifrar y al descifrar', () => {
    const s = cifrar('pin', CTX, { env });
    for (const llave of [
      randomBytes(16).toString('base64'),
      randomBytes(31).toString('hex'),
      randomBytes(33).toString('base64'),
      'no es una llave!',
    ]) {
      const e = { EINVOICING_ENCRYPTION_KEY: llave } as NodeJS.ProcessEnv;
      expect(() => leerLlave(e)).toThrow(LlaveInvalidaError);
      expect(() => cifrar('pin', CTX, { env: e })).toThrow(LlaveInvalidaError);
      expect(() => descifrar(s, CTX, { env: e })).toThrow(LlaveInvalidaError);
    }
  });

  it('el error de llave inválida no imprime la llave', () => {
    const llave = randomBytes(16).toString('base64');
    try {
      leerLlave({ EINVOICING_ENCRYPTION_KEY: llave } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(llave);
    }
  });
});

describe('secretos: subesquema de Mongoose', () => {
  it('campoSecreto() no se selecciona por defecto', () => {
    const opciones = campoSecreto();
    expect(opciones.select).toBe(false);
    expect(opciones.type).toBe(SecretoCifradoSchema);
  });

  /** Modelo de prueba con un campo secreto, sin conexión (no toca Mongo). */
  const Emisor = model(
    'EmisorPruebaSecretos',
    new Schema({ nit: String, claveTecnica: campoSecreto() }),
  );
  const conSecreto = () =>
    new Emisor({ nit: '900123456', claveTecnica: cifrar('abc', CTX, { env }) });

  it('toJSON y toObject omiten el secreto (respuesta de create/save o select +campo)', () => {
    const doc = conSecreto();
    expect(doc.toJSON()).not.toHaveProperty('claveTecnica');
    expect(doc.toObject()).not.toHaveProperty('claveTecnica');
    expect(JSON.stringify(doc)).not.toContain(doc.get('claveTecnica.data') as string);
    expect(doc.toJSON()).toMatchObject({ nit: '900123456' });
  });

  it('el documento sigue pudiendo leer el secreto y lo guarda completo', () => {
    const doc = conSecreto();
    const valor = doc.get('claveTecnica') as SecretoCifrado;
    expect(descifrar({ iv: valor.iv, tag: valor.tag, data: valor.data, v: valor.v }, CTX, { env })).toBe(
      'abc',
    );
    // Lo que va a la base (toBSON) no pasa por el transform.
    const bson = doc.toBSON() as { claveTecnica?: SecretoCifrado };
    expect(bson.claveTecnica?.data).toBe(valor.data);
  });

  it('un objeto plano como el de aggregate/lean no tiene transform: lo cubre el filtro de logs', () => {
    const plano = conSecreto().toBSON() as Record<string, unknown>;
    expect(plano.claveTecnica).toBeDefined();
    expect(redactar(plano)).toMatchObject({ claveTecnica: REDACTADO, nit: '900123456' });
  });

  it('el subesquema solo tiene las cuatro piezas y sin _id', () => {
    const rutas = Object.keys(SecretoCifradoSchema.paths).sort();
    expect(rutas).toEqual(['data', 'iv', 'tag', 'v']);
  });
});
