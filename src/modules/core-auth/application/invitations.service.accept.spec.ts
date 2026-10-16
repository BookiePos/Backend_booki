import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

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

import { NotFoundException } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Ítems 3.5 y 3.6: la aceptación de una invitación es pública. Antes abría la
 * base de cualquier `businessId` que trajera el enlace, sin mirar si la
 * empresa existe, y lo hacía sin su plan: al aceptar no se revisaba el cupo de
 * usuarios.
 */
describe('InvitationsService.accept · empresa del enlace', () => {
  const BIZ = new Types.ObjectId().toString();
  let businesses: { findById: ReturnType<typeof vi.fn> };
  let invitationModel: { findOne: ReturnType<typeof vi.fn> };
  let service: InvitationsService;
  let planDentro: unknown;

  beforeEach(() => {
    planDentro = undefined;
    businesses = { findById: vi.fn() };
    // El token nunca llega a validarse en los casos que se rechazan; en el
    // caso válido basta con capturar el contexto en la primera consulta.
    invitationModel = {
      findOne: vi.fn(() => {
        planDentro = TenantContext.current()?.plan;
        return { exec: () => Promise.resolve(null) };
      }),
    };
    service = new InvitationsService(
      invitationModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      businesses as never,
    );
  });

  it('un businessId con formato inválido da 404 sin abrir ninguna base', async () => {
    await expect(service.accept('no-es-un-id.token', {} as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(businesses.findById).not.toHaveBeenCalled();
    expect(invitationModel.findOne).not.toHaveBeenCalled();
  });

  it('una empresa que no existe da 404 sin abrir su base', async () => {
    businesses.findById.mockResolvedValue(null);

    await expect(service.accept(`${BIZ}.token`, {} as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(invitationModel.findOne).not.toHaveBeenCalled();
  });

  it('una empresa existente se abre con su plan, para aplicar el cupo de usuarios', async () => {
    businesses.findById.mockResolvedValue({
      _id: BIZ,
      plan: 'negocio',
      addOns: {},
      tipoNegocio: 'restaurante',
      status: 'active',
    });

    // El token no existe: falla después, pero ya dentro de la empresa.
    await service.accept(`${BIZ}.token`, {} as never).catch(() => undefined);

    expect(invitationModel.findOne).toHaveBeenCalled();
    expect(planDentro).toBe('negocio');
  });
});
