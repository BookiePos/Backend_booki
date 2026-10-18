import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

// Los controladores importan servicios que importan esquemas: se neutralizan los
// decoradores de Mongoose (SWC emite `Object` para uniones y SchemaFactory revienta).
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({
        index: () => undefined,
        pre: () => undefined,
        virtual: () => ({ get: () => undefined }),
        set: () => undefined,
      }),
    },
  };
});

import { AuthController } from './auth.controller';
import { InvitationsController } from './invitations.controller';
import { REFRESH_COOKIE } from './auth-cookie';
import type { AuthService } from '../application/auth.service';
import type { UsersService } from '../application/users.service';
import type { RegistrationService } from '../application/registration.service';
import type { PasswordResetService } from '../application/password-reset.service';
import type { InvitationsService } from '../application/invitations.service';

/**
 * Ítem 4.4 «Refresh token fuera de JS». El refresh token vive solo en la cookie
 * HttpOnly: ningún endpoint lo devuelve en el body (un XSS podría leerlo) y
 * /auth/refresh y /auth/logout no lo aceptan por body (solo cookie).
 */

const SESSION = {
  tokens: { accessToken: 'acc', refreshToken: 'ref-secreto' },
  user: { id: 'u1', email: 'a@b.co' },
};

const config = { get: () => undefined } as unknown as ConfigService;

function spyRes() {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
}

function req(cookies: Record<string, string> = {}, body: unknown = {}) {
  return { cookies, body } as unknown as Request;
}

function makeAuthController() {
  const auth = {
    login: vi.fn().mockResolvedValue(SESSION),
    refresh: vi
      .fn()
      .mockResolvedValue({ accessToken: 'acc2', refreshToken: 'ref2' }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const registration = {
    solicitar: vi.fn().mockResolvedValue(undefined),
    reenviar: vi.fn().mockResolvedValue(undefined),
    confirmar: vi.fn().mockResolvedValue({ ...SESSION, plan: 'pro' }),
  };
  const ctrl = new AuthController(
    auth as unknown as AuthService,
    {} as UsersService,
    registration as unknown as RegistrationService,
    {} as PasswordResetService,
    config,
  );
  return { ctrl, auth, registration };
}

/** Busca la cadena del refresh token en cualquier parte del body. */
function bodyLeaks(body: unknown, secret: string): boolean {
  return JSON.stringify(body).includes(secret);
}

describe('AuthController — el refresh token nunca sale en el body', () => {
  it('login: body sin refreshToken; el refresh va en la cookie', async () => {
    const { ctrl } = makeAuthController();
    const res = spyRes();
    const body = await ctrl.login({ email: 'a@b.co', password: 'x' }, res);
    expect(body.tokens).toEqual({ accessToken: 'acc' });
    expect(bodyLeaks(body, 'ref-secreto')).toBe(false);
    expect(body.user).toEqual(SESSION.user);
    expect(res.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'ref-secreto',
      expect.objectContaining({ httpOnly: true, path: '/auth' }),
    );
  });

  it('register: responde neutro, sin sesión ni cookie (ítem 4.11)', async () => {
    const { ctrl, registration } = makeAuthController();
    const body = await ctrl.register({ ownerEmail: 'x@y.co' } as never);
    expect(registration.solicitar).toHaveBeenCalled();
    expect(body).toEqual({ ok: true, message: expect.any(String) });
  });

  it('confirmRegister: body sin refreshToken; conserva user y plan', async () => {
    const { ctrl } = makeAuthController();
    const res = spyRes();
    const body = await ctrl.confirmRegister('tok', res);
    expect(body.tokens).toEqual({ accessToken: 'acc' });
    expect(bodyLeaks(body, 'ref-secreto')).toBe(false);
    expect(body.plan).toBe('pro');
    expect(res.cookie.mock.calls[0]![1]).toBe('ref-secreto');
  });

  it('confirmRegisterBody: el token viaja en el body y la respuesta no filtra el refresh', async () => {
    const { ctrl, registration } = makeAuthController();
    const res = spyRes();
    const body = await ctrl.confirmRegisterBody({ token: 'tok-del-body-0123456789' }, res);
    expect(registration.confirmar).toHaveBeenCalledWith('tok-del-body-0123456789');
    expect(bodyLeaks(body, 'ref-secreto')).toBe(false);
    expect(res.cookie.mock.calls[0]![1]).toBe('ref-secreto');
  });

  it('resendRegister: respuesta neutra, sin sesión ni cookie', async () => {
    const { ctrl, registration } = makeAuthController();
    const body = await ctrl.resendRegister({ email: 'x@y.co' });
    expect(registration.reenviar).toHaveBeenCalledWith('x@y.co');
    expect(body).toEqual({ ok: true, message: expect.any(String) });
  });

  it('refresh: rota con la cookie y responde solo el accessToken', async () => {
    const { ctrl, auth } = makeAuthController();
    const res = spyRes();
    const body = await ctrl.refresh(req({ [REFRESH_COOKIE]: 'cookie-tok' }), res);
    expect(auth.refresh).toHaveBeenCalledWith('cookie-tok');
    expect(body).toEqual({ accessToken: 'acc2' });
    expect(res.cookie.mock.calls[0]![1]).toBe('ref2');
  });
});

describe('AuthController — refresh/logout ignoran el body', () => {
  it('refresh sin cookie responde 401 aunque el body traiga refreshToken', async () => {
    const { ctrl, auth } = makeAuthController();
    const res = spyRes();
    await expect(
      ctrl.refresh(req({}, { refreshToken: 'tok-en-body' }), res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('refresh con cookie usa la cookie, nunca el body', async () => {
    const { ctrl, auth } = makeAuthController();
    await ctrl.refresh(
      req({ [REFRESH_COOKIE]: 'cookie-tok' }, { refreshToken: 'tok-en-body' }),
      spyRes(),
    );
    expect(auth.refresh).toHaveBeenCalledWith('cookie-tok');
  });

  it('logout sin cookie no revoca el token del body, pero limpia la cookie', async () => {
    const { ctrl, auth } = makeAuthController();
    const res = spyRes();
    await ctrl.logout(req({}, { refreshToken: 'tok-en-body' }), res);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
  });

  it('logout con cookie revoca el de la cookie', async () => {
    const { ctrl, auth } = makeAuthController();
    await ctrl.logout(
      req({ [REFRESH_COOKIE]: 'cookie-tok' }, { refreshToken: 'tok-en-body' }),
      spyRes(),
    );
    expect(auth.logout).toHaveBeenCalledWith('cookie-tok');
  });
});

describe('InvitationsController.accept — el refresh token nunca sale en el body', () => {
  it('body sin refreshToken; el refresh va en la cookie', async () => {
    const invitations = { accept: vi.fn().mockResolvedValue(SESSION) };
    const ctrl = new InvitationsController(
      invitations as unknown as InvitationsService,
      config,
    );
    const res = spyRes();
    const body = await ctrl.accept('tok', { name: 'N', password: 'p' } as never, res);
    expect(body.tokens).toEqual({ accessToken: 'acc' });
    expect(bodyLeaks(body, 'ref-secreto')).toBe(false);
    expect(res.cookie.mock.calls[0]![1]).toBe('ref-secreto');
  });
});
