import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Aquí los modelos van
// mockeados. Mismo patrón que `sales/application/orders.service.checkout.spec.ts`.
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

import { InvitationsService } from './invitations.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Aceptar una invitación tiene que saber A QUÉ EMPRESA pertenece.
 *
 * Las rutas de aceptación son `@Public()`: quien las abre todavía no es
 * usuario, así que no manda `Bearer` y `TenantMiddleware` no abre ningún
 * contexto. Como `Invitation` es un modelo de tenant, fuera de contexto el
 * proxy devuelve `undefined` y `findOne` ni siquiera es una función: la
 * petición reventaba y el frontend lo pintaba como "Invitación no válida", que
 * mandó a buscar el fallo al sitio equivocado durante días.
 *
 * El enlace lleva ahora la empresa delante del token, y el servicio abre el
 * contexto con ella —el mismo patrón que ya usaba el restablecimiento de
 * contraseña, que sí guardaba `businessId` para esto—.
 *
 * El servicio se instancia DIRECTAMENTE con dependencias mockeadas:
 * (invitationModel, users, roles, mail, auth, config).
 */
describe('InvitationsService · contexto de empresa al aceptar', () => {
  const BUSINESS_ID = '68b0f3c2a1d4e5f6a7b8c9d0';
  const RAW = 'a'.repeat(64);
  const hash = (t: string) => createHash('sha256').update(t).digest('hex');

  /** Empresa vista por el modelo en el momento de la consulta. */
  let seenBusinessId: string | undefined;
  let invitationModel: any;
  let users: any;
  let roles: any;
  let auth: any;
  let service: InvitationsService;

  beforeEach(() => {
    seenBusinessId = undefined;
    const invitation = {
      email: 'nuevo@negocio.com',
      role: 'cashier',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      save: vi.fn().mockResolvedValue(undefined),
    };

    invitationModel = {
      findOne: vi.fn((filter: { tokenHash: string }) => ({
        exec: () => {
          // Lo que se está comprobando: que haya contexto y que sea el correcto.
          seenBusinessId = TenantContext.current()?.businessId;
          // Cada empresa tiene su propia base: la invitación solo existe en la
          // suya. Sin esto el doble mentiría, encontrando el token en
          // cualquier empresa que se pidiera.
          const enSuEmpresa = seenBusinessId === BUSINESS_ID;
          return Promise.resolve(
            enSuEmpresa && filter.tokenHash === hash(RAW) ? invitation : null,
          );
        },
      })),
    };
    users = {
      findByEmail: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'u1' }),
    };
    roles = {
      findByKey: vi.fn().mockResolvedValue({ key: 'cashier', name: 'Cajero' }),
    };
    auth = {
      issueSession: vi.fn().mockResolvedValue({ tokens: {}, user: {} }),
    };

    service = new InvitationsService(
      invitationModel as never,
      users as never,
      roles as never,
      {} as never,
      auth as never,
      { get: () => undefined } as never,
    );
  });

  it('abre el contexto de la empresa que viaja en el enlace', async () => {
    const info = await service.getByToken(`${BUSINESS_ID}.${RAW}`);

    expect(seenBusinessId).toBe(BUSINESS_ID);
    expect(info.email).toBe('nuevo@negocio.com');
    expect(info.roleName).toBe('Cajero');
  });

  it('crea el usuario dentro del contexto de esa empresa, no fuera', async () => {
    await service.accept(`${BUSINESS_ID}.${RAW}`, {
      name: 'Nuevo',
      password: 'Secreta123',
    } as never);

    expect(users.create).toHaveBeenCalledOnce();
    expect(seenBusinessId).toBe(BUSINESS_ID);
    expect(auth.issueSession).toHaveBeenCalledOnce();
  });

  it('un enlace sin empresa (formato viejo) lo dice, en vez de reventar', async () => {
    // Las invitaciones emitidas antes del arreglo llevan solo el token. No hay
    // forma de saber de qué empresa son: el mensaje tiene que pedir un reenvío,
    // no un "no válida" que hace pensar que el enlace está corrupto.
    await expect(service.getByToken(RAW)).rejects.toThrow(/reenv/i);
  });

  it('no busca en otra empresa si el enlace viene manipulado', async () => {
    const otra = '000000000000000000000000';

    await expect(
      service.getByToken(`${otra}.${RAW}`),
    ).rejects.toThrow();
    // Se consultó, pero acotado a la empresa del enlace: nunca a ciegas.
    expect(seenBusinessId).toBe(otra);
  });
});
