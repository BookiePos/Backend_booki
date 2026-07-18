import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import {
  Invitation,
  InvitationDocument,
  InvitationStatus,
} from '../infrastructure/schemas/invitation.schema';
import { UsersService } from './users.service';
import { RolesService } from './roles.service';
import { MailService } from './mail.service';
import { AuthService, AuthTokens, AuthUserView } from './auth.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';

/** Vista de una invitación para la API (sin el hash del token). */
export interface InvitationView {
  id: string;
  email: string;
  role: string;
  roleName: string;
  status: InvitationStatus | 'expired';
  expiresAt: Date;
  createdAt: Date;
  invitedByName?: string;
}

/** Vista de creación: incluye el enlace (útil en modo de pruebas de Resend). */
export interface CreatedInvitationView extends InvitationView {
  inviteUrl: string;
  emailSent: boolean;
}

@Injectable()
export class InvitationsService {
  constructor(
    @InjectModel(Invitation.name)
    private readonly invitationModel: Model<InvitationDocument>,
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly mail: MailService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** Crea una invitación, la envía por correo y devuelve el enlace. */
  async create(
    dto: CreateInvitationDto,
    inviterUserId?: string,
  ): Promise<CreatedInvitationView> {
    const email = dto.email.toLowerCase().trim();

    const role = await this.roles.findByKey(dto.role);
    if (!role) {
      throw new BadRequestException('Rol no válido');
    }

    const existingUser = await this.users.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('Ya existe un usuario con ese correo');
    }

    // Revoca invitaciones pendientes previas para el mismo correo (re-invitar).
    await this.invitationModel
      .updateMany(
        { email, status: 'pending' },
        { $set: { status: 'revoked' } },
      )
      .exec();

    const rawToken = randomBytes(32).toString('hex');
    const invitation = await this.invitationModel.create({
      email,
      role: role.key,
      tokenHash: hashToken(rawToken),
      status: 'pending',
      expiresAt: this.expiryDate(),
      invitedBy: inviterUserId
        ? new Types.ObjectId(inviterUserId)
        : undefined,
    });

    const inviteUrl = this.buildInviteUrl(rawToken);
    const inviterName = await this.inviterName(inviterUserId);
    const result = await this.mail.sendInvitation({
      to: email,
      inviteUrl,
      roleName: role.name,
      inviterName,
    });

    return {
      ...this.toView(invitation, role.name),
      inviteUrl,
      emailSent: result.sent,
    };
  }

  /** Lista invitaciones (más recientes primero). */
  async list(): Promise<InvitationView[]> {
    const invitations = await this.invitationModel
      .find()
      .sort({ createdAt: -1 })
      .populate('invitedBy', 'name')
      .exec();

    const roleNames = await this.roleNameMap();
    return invitations.map((inv) => {
      const inviter = inv.invitedBy as unknown as { name?: string } | undefined;
      return this.toView(
        inv,
        roleNames.get(inv.role) ?? inv.role,
        inviter?.name,
      );
    });
  }

  /** Reenvía una invitación pendiente: nuevo token, nueva expiración, correo. */
  async resend(id: string): Promise<CreatedInvitationView> {
    const invitation = await this.invitationModel.findById(id).exec();
    if (!invitation) {
      throw new NotFoundException('Invitación no encontrada');
    }
    if (invitation.status === 'accepted') {
      throw new BadRequestException('La invitación ya fue aceptada');
    }
    const role = await this.roles.findByKey(invitation.role);
    if (!role) {
      throw new BadRequestException('El rol de la invitación ya no existe');
    }

    const rawToken = randomBytes(32).toString('hex');
    invitation.tokenHash = hashToken(rawToken);
    invitation.status = 'pending';
    invitation.expiresAt = this.expiryDate();
    await invitation.save();

    const inviteUrl = this.buildInviteUrl(rawToken);
    const inviterName = await this.inviterName(
      invitation.invitedBy?.toString(),
    );
    const result = await this.mail.sendInvitation({
      to: invitation.email,
      inviteUrl,
      roleName: role.name,
      inviterName,
    });

    return {
      ...this.toView(invitation, role.name),
      inviteUrl,
      emailSent: result.sent,
    };
  }

  /** Revoca una invitación (deja de ser válida). */
  async revoke(id: string): Promise<void> {
    const invitation = await this.invitationModel.findById(id).exec();
    if (!invitation) {
      throw new NotFoundException('Invitación no encontrada');
    }
    if (invitation.status === 'accepted') {
      throw new BadRequestException('La invitación ya fue aceptada');
    }
    invitation.status = 'revoked';
    await invitation.save();
  }

  /** Valida un token (público) y devuelve datos para la pantalla de aceptación. */
  async getByToken(
    rawToken: string,
  ): Promise<{ email: string; role: string; roleName: string }> {
    const invitation = await this.requireValidToken(rawToken);
    const role = await this.roles.findByKey(invitation.role);
    return {
      email: invitation.email,
      role: invitation.role,
      roleName: role?.name ?? invitation.role,
    };
  }

  /** Acepta la invitación: crea el usuario y devuelve una sesión iniciada. */
  async accept(
    rawToken: string,
    dto: AcceptInvitationDto,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView }> {
    const invitation = await this.requireValidToken(rawToken);

    const existingUser = await this.users.findByEmail(invitation.email);
    if (existingUser) {
      invitation.status = 'accepted';
      invitation.acceptedAt = new Date();
      await invitation.save();
      throw new ConflictException('Ya existe un usuario con ese correo');
    }

    const role = await this.roles.findByKey(invitation.role);
    if (!role) {
      throw new BadRequestException('El rol de la invitación ya no existe');
    }

    const user = await this.users.create({
      email: invitation.email,
      password: dto.password,
      name: dto.name,
      role: invitation.role,
    });

    invitation.status = 'accepted';
    invitation.acceptedAt = new Date();
    await invitation.save();

    return this.auth.issueSession(user);
  }

  // ---- helpers ----

  private async requireValidToken(
    rawToken: string,
  ): Promise<InvitationDocument> {
    const invitation = await this.invitationModel
      .findOne({ tokenHash: hashToken(rawToken) })
      .exec();
    if (!invitation || invitation.status === 'revoked') {
      throw new NotFoundException('Invitación no válida');
    }
    if (invitation.status === 'accepted') {
      throw new GoneException('La invitación ya fue aceptada');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new GoneException('La invitación expiró');
    }
    return invitation;
  }

  private buildInviteUrl(rawToken: string): string {
    const base = (
      this.config.get<string>('APP_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    return `${base}/invitacion/${rawToken}`;
  }

  private expiryDate(): Date {
    const days = Number(this.config.get<string>('INVITE_EXPIRES_DAYS') ?? '7');
    const safe = Number.isFinite(days) && days > 0 ? days : 7;
    return new Date(Date.now() + safe * 24 * 3600 * 1000);
  }

  private async inviterName(userId?: string): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
      const user = await this.users.findById(userId);
      return user.name;
    } catch {
      return undefined;
    }
  }

  private async roleNameMap(): Promise<Map<string, string>> {
    const roles = await this.roles.list();
    return new Map(roles.map((r) => [r.key, r.name]));
  }

  private toView(
    inv: InvitationDocument,
    roleName: string,
    invitedByName?: string,
  ): InvitationView {
    const expired =
      inv.status === 'pending' && inv.expiresAt.getTime() < Date.now();
    return {
      id: inv.id,
      email: inv.email,
      role: inv.role,
      roleName,
      status: expired ? 'expired' : inv.status,
      expiresAt: inv.expiresAt,
      createdAt: (inv as unknown as { createdAt: Date }).createdAt,
      invitedByName,
    };
  }
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
