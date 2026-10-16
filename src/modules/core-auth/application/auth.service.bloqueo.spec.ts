import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { HttpException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { FALLOS_PARA_BLOQUEO, IntentosLoginService } from './intentos-login.service';
import { coleccionFalsa } from '../../../shared/throttle/coleccion-falsa';

/**
 * Ítem 4.3: bloqueo temporal por cuenta. El throttle por IP no frena a quien
 * prueba contraseñas desde muchas IP contra la misma cuenta.
 */
describe('AuthService · bloqueo por cuenta tras fallos de login', () => {
  const BIZ = '68b0f3c2a1d4e5f6a7b8c9d0';
  let users: any;
  let service: AuthService;
  let col: ReturnType<typeof coleccionFalsa> & { findOne: any; deleteOne: any };

  beforeEach(() => {
    const base = coleccionFalsa();
    col = Object.assign(base, {
      findOne: vi.fn(async (f: { _id: string; hasta: { $gt: Date } }) => {
        const d = base.docs.get(f._id);
        return d && d.hasta > f.hasta.$gt ? d : null;
      }),
      deleteOne: vi.fn(async (f: { _id: string }) => base.docs.delete(f._id)),
    });
    const intentos = new IntentosLoginService({ collection: () => col } as never);
    users = {
      findByEmail: vi.fn(async () => ({ id: 'u1', active: true })),
      findByUsername: vi.fn(async () => null),
      verifyPassword: vi.fn(async () => false),
    };
    const directory = {
      findByEmail: vi.fn(async (email: string) =>
        email === 'nadie@x.co' ? null : { businessId: BIZ, dbName: `biz_${BIZ}` },
      ),
      findByUsername: vi.fn(async () => null),
    };
    service = new AuthService(
      users,
      {} as never,
      { get: () => undefined } as never,
      directory as never,
      {} as never,
      {} as never,
      intentos,
    );
  });

  async function fallar(email: string, veces: number) {
    for (let i = 0; i < veces; i++) {
      await expect(service.login(email, 'mala')).rejects.toBeInstanceOf(UnauthorizedException);
    }
  }

  it(`tras ${FALLOS_PARA_BLOQUEO} fallos responde 429 sin mirar la contraseña`, async () => {
    await fallar('ana@x.co', FALLOS_PARA_BLOQUEO);
    users.verifyPassword.mockClear();
    users.verifyPassword.mockResolvedValue(true);

    const err = await service.login('ana@x.co', 'buena').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(users.verifyPassword).not.toHaveBeenCalled();
  });

  it('una cuenta que no existe se bloquea igual (el bloqueo no delata cuáles existen)', async () => {
    await fallar('nadie@x.co', FALLOS_PARA_BLOQUEO);
    const err = await service.login('nadie@x.co', 'x').catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('un login correcto antes del límite borra los fallos', async () => {
    await fallar('ana@x.co', FALLOS_PARA_BLOQUEO - 1);
    users.verifyPassword.mockResolvedValue(true);
    vi.spyOn(service as any, 'issueTokens').mockResolvedValue({ accessToken: 't' });
    vi.spyOn(service as any, 'toView').mockResolvedValue({});
    await service.login('ana@x.co', 'buena');
    expect(col.docs.size).toBe(0);
  });

  it('el bloqueo es por cuenta: otra cuenta sigue entrando', async () => {
    await fallar('ana@x.co', FALLOS_PARA_BLOQUEO);
    await expect(service.login('beto@x.co', 'mala')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
