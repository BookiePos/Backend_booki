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

import { UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuthService, REFRESH_REUSE_GRACE_MS } from './auth.service';

/**
 * Refrescar la sesión.
 *
 * Ítem 3.2: desactivar a alguien le corta el acceso (el refresh no lo miraba).
 * Ítem 4.9: la rotación es atómica y la reutilización de un refresh ya rotado
 *           se trata como robo.
 * Ítem 3.7: `jti` y `typ` obligatorios en el refresh token.
 *
 * El constructor es: (users, jwt, config, directory, businesses, refreshModel).
 */
describe('AuthService · refrescar la sesión', () => {
  const BUSINESS_ID = '68b0f3c2a1d4e5f6a7b8c9d0';
  const USER_ID = '68b0f3c2a1d4e5f6a7b8c9aa';

  /** Fila de `refresh_tokens` en una "base" en memoria. */
  interface Fila {
    jti: string;
    userId: Types.ObjectId;
    expiresAt: Date;
    revoked: boolean;
    rotatedAt?: Date;
  }

  let usuario: any;
  let users: any;
  let jwt: any;
  let filas: Fila[];
  let fila: Fila;
  let refreshModel: any;
  let service: AuthService;

  /** Aplica el filtro como lo haría Mongo, solo para los campos que se usan. */
  function coincide(f: Fila, filtro: Record<string, any>): boolean {
    return Object.entries(filtro).every(([k, v]) => {
      const actual = (f as any)[k];
      if (v && typeof v === 'object' && '$gt' in v) return actual > v.$gt;
      if (v instanceof Types.ObjectId) return v.equals(actual);
      return actual === v;
    });
  }

  beforeEach(() => {
    usuario = {
      id: USER_ID,
      email: 'c@x.com',
      role: 'cashier',
      active: true,
      sedeIds: [],
    };
    users = {
      findById: vi.fn(async () => usuario),
      effectivePermissions: vi.fn(async () => []),
      revokeAllSessions: vi.fn(async () => undefined),
    };
    jwt = {
      verifyAsync: vi.fn(async () => ({
        sub: USER_ID,
        jti: 'j1',
        biz: BUSINESS_ID,
        typ: 'refresh',
      })),
      signAsync: vi.fn(async () => 'token'),
    };
    fila = {
      jti: 'j1',
      userId: new Types.ObjectId(USER_ID),
      expiresAt: new Date(Date.now() + 60_000),
      revoked: false,
    };
    filas = [fila];
    refreshModel = {
      // Atómico por construcción: lee y escribe en el mismo paso síncrono.
      findOneAndUpdate: vi.fn((filtro: any, update: any) => ({
        exec: async () => {
          const f = filas.find((x) => coincide(x, filtro));
          if (!f) return null;
          const antes = { ...f };
          Object.assign(f, update.$set ?? update);
          return antes;
        },
      })),
      findOne: vi.fn((filtro: any) => ({
        exec: async () => filas.find((x) => coincide(x, filtro)) ?? null,
      })),
      create: vi.fn(async (doc: Fila) => {
        filas.push(doc);
      }),
    };
    service = new AuthService(
      users as never,
      jwt as never,
      { get: (k: string) => (k === 'JWT_SECRET' ? 'acceso' : 'refresco') } as never,
      {} as never,
      { findById: vi.fn(async () => null) } as never,
      refreshModel as never,
    );
  });

  // ── Ítem 3.2 ────────────────────────────────────────────────────────────────

  it('un usuario desactivado no renueva su sesión', async () => {
    usuario.active = false;
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('un usuario que ya no existe tampoco (401, no 404)', async () => {
    users.findById = vi.fn(async () => {
      throw new Error('Usuario no encontrado');
    });
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('un usuario activo sí la renueva', async () => {
    const tokens = await service.refresh('rt');
    expect(tokens.accessToken).toBe('token');
  });

  // ── Ítem 4.9: rotación atómica ─────────────────────────────────────────────

  it('rota con un findOneAndUpdate condicionado a {jti, revoked:false}', async () => {
    await service.refresh('rt');
    const [filtro, update] = refreshModel.findOneAndUpdate.mock.calls[0];
    expect(filtro).toMatchObject({ jti: 'j1', revoked: false });
    expect(update.$set).toMatchObject({ revoked: true });
    expect(fila.revoked).toBe(true);
  });

  it('dos refresh simultáneos con el mismo token: solo uno gana', async () => {
    const resultados = await Promise.allSettled([
      service.refresh('rt'),
      service.refresh('rt'),
    ]);
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    // Una sola sesión nueva, no dos.
    expect(refreshModel.create).toHaveBeenCalledTimes(1);
  });

  it('un refresh vencido no rota', async () => {
    fila.expiresAt = new Date(Date.now() - 1);
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(refreshModel.create).not.toHaveBeenCalled();
  });

  it('el refresh de otro usuario no rota (sub y userId deben casar)', async () => {
    fila.userId = new Types.ObjectId();
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(refreshModel.create).not.toHaveBeenCalled();
  });

  // ── Ítem 4.9: detección de reutilización ───────────────────────────────────

  it('reutilizar un refresh rotado hace rato revoca TODAS las sesiones', async () => {
    fila.revoked = true;
    fila.rotatedAt = new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1_000);
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.revokeAllSessions).toHaveBeenCalledWith(USER_ID);
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('dentro del margen de gracia (carrera del frontend) solo responde 401', async () => {
    fila.revoked = true;
    fila.rotatedAt = new Date(Date.now() - 1_000);
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('un refresh revocado por logout (no rotado) no dispara la alarma', async () => {
    fila.revoked = true;
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.revokeAllSessions).not.toHaveBeenCalled();
  });

  // ── Ítem 3.7: jti y typ ────────────────────────────────────────────────────

  it('un refresh sin jti se rechaza sin tocar la base', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: USER_ID, biz: BUSINESS_ID });
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(refreshModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(refreshModel.findOne).not.toHaveBeenCalled();
  });

  it('un access token presentado como refresh se rechaza', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: USER_ID,
      jti: 'j1',
      biz: BUSINESS_ID,
      typ: 'access',
    });
    await expect(service.refresh('rt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(refreshModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('verifica con el secreto de refresh, no con el del access', async () => {
    await service.refresh('rt');
    expect(jwt.verifyAsync.mock.calls[0][1]).toMatchObject({
      secret: 'refresco',
    });
  });

  it('los tokens emitidos llevan typ access / refresh', async () => {
    await service.refresh('rt');
    const [access] = jwt.signAsync.mock.calls[0];
    const [refresh, opts] = jwt.signAsync.mock.calls[1];
    expect(access.typ).toBe('access');
    expect(refresh.typ).toBe('refresh');
    expect(opts.secret).toBe('refresco');
    expect(access.sid).toBe(refresh.jti);
  });
});
