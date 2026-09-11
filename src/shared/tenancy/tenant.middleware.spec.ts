import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas (aquí llega el de Business
// por la cadena de imports). Mismo patrón que el resto de las pruebas.
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

import { TenantMiddleware } from './tenant.middleware';
import { TenantContext } from './tenant-context';

/**
 * El middleware traduce el claim `biz` del access token en contexto de empresa.
 *
 * El caso que importa aquí es el token VÁLIDO pero sin empresa: los emitidos
 * antes del modelo multi-empresa. El JwtAuthGuard los acepta, así que dejarlos
 * pasar sin contexto llevaba la petición hasta los modelos —proxies inertes— y
 * el handler moría en 500 con "no es una función". Debe cortarse en 401, que es
 * lo que hace al cliente refrescar y, al fallar también el refresh, volver al
 * login.
 */
describe('TenantMiddleware', () => {
  const BUSINESS_ID = '68b0f3c2a1d4e5f6a7b8c9d0';

  let jwt: any;
  let businesses: any;
  let middleware: TenantMiddleware;
  let next: any;

  function request(token?: string) {
    return {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      path: '/invitations',
    } as never;
  }

  beforeEach(() => {
    jwt = { verify: vi.fn() };
    businesses = { findById: vi.fn().mockResolvedValue(null) };
    middleware = new TenantMiddleware(
      jwt as never,
      { get: () => 'secreto-de-pruebas' } as never,
      businesses as never,
    );
    next = vi.fn();
  });

  it('abre el contexto de la empresa del token', async () => {
    jwt.verify.mockReturnValue({ biz: BUSINESS_ID, biztype: 'retail' });
    let seen: string | undefined;
    next.mockImplementation(() => {
      seen = TenantContext.current()?.businessId;
    });

    middleware.use(request('token-bueno'), {} as never, next);
    // `resolveGate` consulta el control-plane: se deja resolver la microtarea.
    await new Promise((r) => setTimeout(r, 0));

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(seen).toBe(BUSINESS_ID);
  });

  it('un token válido SIN empresa se corta en 401, no llega al handler', () => {
    jwt.verify.mockReturnValue({ sub: 'u1' });

    middleware.use(request('token-viejo'), {} as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedException);
  });

  it('un token ilegible sigue sin contexto: lo rechaza el guard de auth', () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });

    middleware.use(request('token-vencido'), {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(TenantContext.current()).toBeUndefined();
  });

  it('sin cabecera de autorización pasa de largo (rutas públicas)', () => {
    middleware.use(request(), {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(jwt.verify).not.toHaveBeenCalled();
  });
});
