import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo mock que `auth.service.logout.spec.ts`: SWC emite `Object` como
// metadata para los @Prop() con uniones de literales y @nestjs/mongoose revienta
// al importar los esquemas.
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

const bcryptCompare = vi.fn(async () => false);
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...actual,
    compare: (...args: unknown[]) =>
      (bcryptCompare as (...a: unknown[]) => Promise<boolean>)(...args),
  };
});

import { UnauthorizedException } from '@nestjs/common';
import { AuthService, HASH_FICTICIO } from './auth.service';
import { getRounds } from 'bcryptjs';

/**
 * Ítem 4.9: el login no debe decir, ni por el texto ni por el tiempo, si una
 * cuenta existe.
 *
 * Antes, un correo desconocido salía en cuanto el directorio respondía vacío,
 * sin pasar por bcrypt (~70 ms con 10 rondas): medir la latencia bastaba para
 * saber qué correos están registrados. Ahora todos los caminos de rechazo
 * pagan una comparación bcrypt y responden el mismo 401.
 *
 * El constructor es: (users, jwt, config, directory, businesses, refreshModel).
 */
describe('AuthService · login sin enumeración', () => {
  const BUSINESS_ID = '68b0f3c2a1d4e5f6a7b8c9d0';
  let users: any;
  let directory: any;
  let service: AuthService;

  beforeEach(() => {
    bcryptCompare.mockClear();
    users = {
      findByEmail: vi.fn(async () => null),
      findByUsername: vi.fn(async () => null),
      verifyPassword: vi.fn(async () => false),
    };
    directory = {
      findByEmail: vi.fn(async () => ({
        businessId: BUSINESS_ID,
        dbName: `biz_${BUSINESS_ID}`,
      })),
      findByUsername: vi.fn(async () => null),
    };
    service = new AuthService(
      users as never,
      {} as never,
      { get: () => undefined } as never,
      directory as never,
      {} as never,
      {} as never,
      {
        assertNoBloqueada: vi.fn(async () => undefined),
        registrarFallo: vi.fn(async () => undefined),
        limpiar: vi.fn(async () => undefined),
      } as never,
    );
  });

  async function mensajeDe(p: Promise<unknown>): Promise<string> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnauthorizedException);
    return (err as UnauthorizedException).message;
  }

  it('un correo que no está en el directorio también pasa por bcrypt', async () => {
    directory.findByEmail.mockResolvedValue(null);
    const msg = await mensajeDe(service.login('nadie@x.com', 'Clave123!'));
    // Una sola comparación contra el hash ya calculado: ningún `bcrypt.hash`
    // en la primera petición de la instancia.
    expect(bcryptCompare).toHaveBeenCalledTimes(1);
    expect(bcryptCompare).toHaveBeenCalledWith('Clave123!', HASH_FICTICIO);
    expect(msg).toBe('Credenciales inválidas');
  });

  it('un usuario de directorio que ya no está en su empresa también', async () => {
    const msg = await mensajeDe(service.login('fantasma@x.com', 'Clave123!'));
    expect(bcryptCompare).toHaveBeenCalledTimes(1);
    expect(msg).toBe('Credenciales inválidas');
  });

  it('un usuario inactivo compara su hash y responde lo mismo', async () => {
    users.findByEmail.mockResolvedValue({ active: false, passwordHash: 'h' });
    const msg = await mensajeDe(service.login('baja@x.com', 'Clave123!'));
    expect(
      bcryptCompare.mock.calls.length + users.verifyPassword.mock.calls.length,
    ).toBe(1);
    expect(msg).toBe('Credenciales inválidas');
  });

  it('una contraseña equivocada responde el mismo mensaje', async () => {
    users.findByEmail.mockResolvedValue({ active: true, passwordHash: 'h' });
    const msg = await mensajeDe(service.login('c@x.com', 'mala'));
    expect(users.verifyPassword).toHaveBeenCalledTimes(1);
    expect(msg).toBe('Credenciales inválidas');
  });

  it('el hash señuelo tiene las mismas rondas que los hashes reales (10)', () => {
    expect(getRounds(HASH_FICTICIO)).toBe(10);
  });
});
