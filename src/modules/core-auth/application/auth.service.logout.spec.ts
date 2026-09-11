import { describe, it, expect, vi, beforeEach } from 'vitest';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Aquí los modelos van
// mockeados. Mismo patrón que `password-reset.service.spec.ts`.
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

import { AuthService } from './auth.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Cerrar sesión tiene que revocar el refresh token EN LA BASE DE SU EMPRESA.
 *
 * La empresa sale del propio refresh token, no del contexto que abrió el
 * middleware desde el access token. Sin esa distinción, un access token sin
 * empresa dejaba el modelo como proxy inerte, `updateOne` no era una función y
 * el `catch` se comía el TypeError: la respuesta era 204 y el token seguía
 * sirviendo.
 *
 * El constructor es: (users, jwt, config, directory, businesses, refreshModel).
 */
describe('AuthService · cierre de sesión', () => {
  const BUSINESS_ID = '68b0f3c2a1d4e5f6a7b8c9d0';

  let seenBusinessId: string | undefined;
  let updateOne: any;
  let refreshModel: any;
  let jwt: any;
  let service: AuthService;

  beforeEach(() => {
    seenBusinessId = undefined;
    updateOne = vi.fn(() => ({
      exec: () => {
        seenBusinessId = TenantContext.current()?.businessId;
        return Promise.resolve({ modifiedCount: 1 });
      },
    }));
    refreshModel = { updateOne };
    jwt = { verifyAsync: vi.fn() };

    service = new AuthService(
      {} as never,
      jwt as never,
      { get: () => 'secreto-de-pruebas' } as never,
      {} as never,
      {} as never,
      refreshModel as never,
    );
  });

  it('revoca el token dentro de la empresa que viaja en el propio token', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'u1',
      jti: 'jti-1',
      biz: BUSINESS_ID,
    });

    await service.logout('refresh-valido');

    expect(updateOne).toHaveBeenCalledWith({ jti: 'jti-1' }, { revoked: true });
    expect(seenBusinessId).toBe(BUSINESS_ID);
  });

  it('un token ilegible no revoca nada y tampoco revienta', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('jwt malformed'));

    await expect(service.logout('basura')).resolves.toBeUndefined();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('propaga el fallo al revocar: no se anuncia una sesión cerrada que no lo está', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'u1',
      jti: 'jti-1',
      biz: BUSINESS_ID,
    });
    updateOne.mockReturnValue({
      exec: () => Promise.reject(new Error('sin conexión a la base')),
    });

    await expect(service.logout('refresh-valido')).rejects.toThrow(
      'sin conexión a la base',
    );
  });
});
