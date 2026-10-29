import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cifrar } from '../crypto/secretos';
import {
  LoggerSeguro,
  MAX_TEXTO,
  NO_REGISTRABLE,
  REDACTADO,
  esClaveSensible,
  redactar,
  redactarTexto,
  registrable,
} from './redaccion';
import { censurar, limpiarEvento } from './sentry';
import type * as Sentry from '@sentry/node';

const env = { EINVOICING_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv;

describe('esClaveSensible', () => {
  it('reconoce los campos sensibles en cualquier estilo', () => {
    for (const c of [
      'password',
      'passwordHash',
      'pin',
      'softwarePin',
      'pin_hash',
      'claveTecnica',
      'clave_tecnica',
      'p12',
      'certificadoP12',
      'certificado',
      'client_secret',
      'clientSecret',
      'contraseña',
      'refreshToken',
      'Authorization',
      'pass',
      'db_pass',
      'passwd',
      'passphrase',
      'pwd',
      'apikey',
      'api_key',
      'clave-tecnica',
    ]) {
      expect(esClaveSensible(c), c).toBe(true);
    }
  });

  it('no censura campos normales que contienen «pin» u otras letras', () => {
    for (const c of ['shipping', 'mapping', 'spinner', 'shopping', 'nombre', 'total', 'nit', 'opinion', 'compass', 'passenger']) {
      expect(esClaveSensible(c), c).toBe(false);
    }
  });
});

describe('redactar', () => {
  it('censura campos sensibles a cualquier profundidad sin mutar el original', () => {
    const original = {
      nombre: 'Crunchy Munch',
      emisor: { nit: '900123456', claveTecnica: 'fc8eac422eba16e22ffd8c6f94b3f40a6e38162c' },
      usuarios: [{ email: 'a@b.co', password: 'Secreta123' }],
    };
    const r = redactar(original) as typeof original;
    expect(r.nombre).toBe('Crunchy Munch');
    expect(r.emisor.nit).toBe('900123456');
    expect(r.emisor.claveTecnica).toBe(REDACTADO);
    expect(r.usuarios[0]?.password).toBe(REDACTADO);
    expect(original.emisor.claveTecnica).toBe('fc8eac422eba16e22ffd8c6f94b3f40a6e38162c');
  });

  it('censura cualquier objeto cifrado aunque el campo tenga un nombre inocente', () => {
    const r = redactar({ dato: cifrar('pin', 'emisor1:pin', { env }), otro: 1 }) as Record<string, unknown>;
    expect(r.dato).toBe(REDACTADO);
    expect(r.otro).toBe(1);
  });

  it('censura buffers (un .p12 en memoria)', () => {
    expect(redactar({ archivo: Buffer.from('MIIK...') })).toEqual({ archivo: REDACTADO });
  });

  it('aguanta referencias circulares', () => {
    const a: Record<string, unknown> = { pin: '1234' };
    a.yo = a;
    expect(redactar(a)).toEqual({ pin: REDACTADO, yo: '[circular]' });
  });

  it('conserva los errores como Error con el mensaje censurado', () => {
    const r = redactar(new Error('fallo con password=Secreta123'));
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toBe(`fallo con password=${REDACTADO}`);
  });
});

describe('redactarTexto', () => {
  it('censura pares clave=valor, clave: valor y JSON', () => {
    expect(redactarTexto('login password=Secreta123 ok')).toBe(`login password=${REDACTADO} ok`);
    // La coma puede ser parte del valor: se censura con él.
    expect(redactarTexto('pin: 1234, nit: 900')).toBe(`pin: ${REDACTADO} nit: 900`);
    expect(redactarTexto('{"claveTecnica":"abc123","nit":"900"}')).toBe(
      `{"claveTecnica":"${REDACTADO}","nit":"900"}`,
    );
    expect(redactarTexto('?client_secret=xyz&a=1')).toBe(`?client_secret=${REDACTADO}&a=1`);
  });

  it('deja intacto el texto sin secretos', () => {
    const t = 'shipping=10 mapping: ok, total=5000';
    expect(redactarTexto(t)).toBe(t);
  });

  it('Sentry también lo aplica en los mensajes de excepción', () => {
    expect(censurar('p12Password=abc')).toBe(`p12Password=${REDACTADO}`);
  });
});

describe('redactarTexto: valores completos', () => {
  it('censura el esquema y el token de Authorization', () => {
    const r = redactarTexto('Authorization: Bearer abc.def.ghi\nsiguiente linea');
    expect(r).toBe(`Authorization: ${REDACTADO}\nsiguiente linea`);
    expect(redactarTexto('token=Bearer abc.def')).toBe(`token=${REDACTADO}`);
    expect(redactarTexto('Cookie: a=1; sesion=xyz')).toBe(`Cookie: ${REDACTADO}`);
  });

  it('consume el valor entre comillas hasta la de cierre, con escapes', () => {
    expect(redactarTexto('password="mi clave secreta" ok')).toBe(`password="${REDACTADO}" ok`);
    expect(redactarTexto(`pin='12 34' fin`)).toBe(`pin='${REDACTADO}' fin`);
    expect(redactarTexto('password="a\\"b c" fin')).toBe(`password="${REDACTADO}" fin`);
  });

  it('no deja ver lo que sigue a una coma o punto y coma dentro del valor', () => {
    expect(redactarTexto('password=ab,cd fin')).toBe(`password=${REDACTADO} fin`);
    expect(redactarTexto('password=ab;cd fin')).toBe(`password=${REDACTADO} fin`);
  });

  it('cubre el JSON doblemente escapado', () => {
    expect(redactarTexto('{\\"pin\\":\\"1234\\",\\"nit\\":\\"900\\"}')).toBe(
      `{\\"pin\\":\\"${REDACTADO}\\",\\"nit\\":\\"900\\"}`,
    );
  });

  it('cubre clave-tecnica y las variantes de contraseña y api key', () => {
    for (const clave of ['clave-tecnica', 'pass', 'passwd', 'passphrase', 'pwd', 'apikey', 'api_key']) {
      expect(redactarTexto(`${clave}=s3creto x`), clave).toBe(`${clave}=${REDACTADO} x`);
    }
  });

  it('recorta los textos enormes en vez de dejarlos sin filtrar', () => {
    const r = redactarTexto('a'.repeat(MAX_TEXTO + 500) + ' password=fuga');
    expect(r).not.toContain('fuga');
    expect(r.endsWith('[recortado]')).toBe(true);
  });
});

describe('redactarTexto: tiempo lineal (ReDoS)', () => {
  for (const [nombre, texto] of [
    ["'pin'.repeat(5000)", 'pin'.repeat(5000)],
    ["'a'.repeat(50000)", 'a'.repeat(50000)],
    ["'pin='.repeat(5000)", 'pin='.repeat(5000)],
    ['"x":'.repeat(5000), '"x":'.repeat(5000)],
  ] as const) {
    it(`${nombre.slice(0, 20)} tarda menos de 50 ms`, () => {
      redactarTexto('calentar password=x');
      const inicio = performance.now();
      redactarTexto(texto);
      expect(performance.now() - inicio).toBeLessThan(50);
    });
  }
});

describe('redactar: documentos, causas y fallos', () => {
  it('convierte con toJSON antes de recorrer', () => {
    const doc = { toJSON: () => ({ nit: '900', pin: '1234' }) };
    expect(redactar(doc)).toEqual({ nit: '900', pin: REDACTADO });
  });

  it('censura la causa de un Error', () => {
    // `cause` es ES2022 y el tsconfig apunta más atrás: se asigna a mano.
    const err = Object.assign(new Error('externo'), { cause: new Error('fallo password=Secreta123') });
    const r = redactar(err) as Error & { cause?: Error };
    expect(r.cause).toBeInstanceOf(Error);
    expect(r.cause?.message).toBe(`fallo password=${REDACTADO}`);
  });

  it('registrable() no lanza: un getter roto da [no-registrable]', () => {
    const roto = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(registrable(roto)).toBe(NO_REGISTRABLE);
  });
});

describe('limpiarEvento: contextos, etiquetas y logentry', () => {
  it('pasa contexts, tags y logentry por el filtro', () => {
    const evento = {
      contexts: { emisor: { nit: '900', claveTecnica: 'zzz' } },
      tags: { ruta: '/x', token: 'abc' },
      logentry: { message: 'login password=Secreta1', params: [{ pin: '1234' }] },
    } as unknown as Sentry.ErrorEvent;
    const limpio = limpiarEvento(evento);
    const texto = JSON.stringify(limpio);
    for (const fuga of ['zzz', 'abc', 'Secreta1', '1234']) expect(texto).not.toContain(fuga);
    expect(texto).toContain('/x');
  });
});

describe('LoggerSeguro', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no deja salir el secreto por stdout ni stderr', () => {
    const salidas: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => (salidas.push(String(t)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((t) => (salidas.push(String(t)), true));
    const logger = new LoggerSeguro('Prueba');
    logger.log({ pin: '987654', nombre: 'caja' });
    logger.error('fallo password=Secreta123', 'pila con token=abc.def');
    logger.warn(`dto ${JSON.stringify({ claveTecnica: 'zzz999' })}`);
    const todo = salidas.join('');
    expect(todo).not.toContain('987654');
    expect(todo).not.toContain('Secreta123');
    expect(todo).not.toContain('abc.def');
    expect(todo).not.toContain('zzz999');
    expect(todo).toContain('caja');
    expect(todo).toContain(REDACTADO);
  });
});
