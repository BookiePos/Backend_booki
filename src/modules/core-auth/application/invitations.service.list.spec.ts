import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mismo mock que `invitations.service.tenant.spec.ts`: SWC emite `Object` como
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

import { InvitationsService } from './invitations.service';

/**
 * Listar invitaciones muestra QUIÉN invitó, y eso sale de `populate('invitedBy')`.
 *
 * Los modelos se compilan de forma perezosa sobre la conexión de cada empresa,
 * así que "User" puede no existir todavía en ella cuando entra la petición: la
 * pantalla de Usuarios y roles pide usuarios, roles e invitaciones EN PARALELO,
 * y si la de invitaciones llega primero, mongoose lanza MissingSchemaError y el
 * apartado sale en "internal server error" hasta que otra petición compila el
 * modelo. Pasar el modelo explícito a `populate` quita esa carrera.
 */
describe('InvitationsService · listado', () => {
  let userModel: any;
  let populate: any;
  let invitationModel: any;
  let service: InvitationsService;

  beforeEach(() => {
    userModel = { modelName: 'User' };
    const query: any = {
      sort: vi.fn(() => query),
      populate: vi.fn(() => query),
      exec: vi.fn().mockResolvedValue([]),
    };
    populate = query.populate;
    invitationModel = { find: vi.fn(() => query) };

    service = new InvitationsService(
      invitationModel as never,
      userModel as never,
      {} as never,
      { list: vi.fn().mockResolvedValue([]) } as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
    );
  });

  it('pobla `invitedBy` con el modelo inyectado, no por nombre', async () => {
    await service.list();

    expect(populate).toHaveBeenCalledWith({
      path: 'invitedBy',
      select: 'name',
      model: userModel,
    });
  });
});
