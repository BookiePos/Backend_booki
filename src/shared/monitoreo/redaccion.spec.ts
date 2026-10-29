import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cifrar } from '../crypto/secretos';
import { LoggerSeguro, REDACTADO, esClaveSensible, redactar, redactarTexto } from './redaccion';
import { censurar } from './sentry';

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
    ]) {
      expect(esClaveSensible(c), c).toBe(true);
    }
  });

  it('no censura campos normales que contienen «pin» u otras letras', () => {
    for (const c of ['shipping', 'mapping', 'spinner', 'shopping', 'nombre', 'total', 'nit', 'opinion']) {
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
    const r = redactar({ dato: cifrar('pin', { env }), otro: 1 }) as Record<string, unknown>;
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
    expect(redactarTexto('pin: 1234, nit: 900')).toBe(`pin: ${REDACTADO}, nit: 900`);
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
