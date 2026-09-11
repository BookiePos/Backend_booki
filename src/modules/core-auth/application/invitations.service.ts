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
import { User } from '../infrastructure/schemas/user.schema';
import { UsersService } from './users.service';
import { RolesService } from './roles.service';
import { MailService } from './mail.service';
import { AuthService, AuthTokens, AuthUserView } from './auth.service';
import {
  TenantContext,
  dbNameForBusiness,
} from '../../../shared/tenancy/tenant-context';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';

/**
 * Discriminadores de por qué un enlace de invitación no sirve.
 *
 * Van en el cuerpo del error, como `ACCOUNT_SUSPENDED`, porque la pantalla de
 * aceptación tiene que decir cosas distintas —y ofrecer salidas distintas— para
 * cada caso: una invitación vencida se resuelve pidiendo otra, una ya aceptada
 * se resuelve iniciando sesión, y una revocada no se resuelve sola. Antes todas
 * caían en el mismo "Invitación no válida", que además tapó un 500 durante
 * días.
 */
export const INVITATION_ERRORS = {
  /** Enlace anterior al formato con empresa: no se puede resolver. */
  LEGACY_LINK: 'INVITATION_LEGACY_LINK',
  /** El token no corresponde a ninguna invitación. */
  NOT_FOUND: 'INVITATION_NOT_FOUND',
  /** El dueño la canceló. */
  REVOKED: 'INVITATION_REVOKED',
  /** Ya se usó: la cuenta existe. */
  ACCEPTED: 'INVITATION_ACCEPTED',
  /** Se pasó de la fecha de expiración. */
  EXPIRED: 'INVITATION_EXPIRED',
  /** Al aceptar: ese correo ya tiene cuenta en la empresa. */
  EMAIL_TAKEN: 'INVITATION_EMAIL_TAKEN',
} as const;

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
    /**
     * Modelo referenciado por `invitedBy`. Se pasa EXPLÍCITO a `populate` para
     * no depender de que "User" ya esté compilado en la conexión del tenant
     * activo: los modelos se compilan de forma perezosa por empresa, así que
     * quien llegara primero a `GET /invitations` reventaba con
     * MissingSchemaError (500). Mismo arreglo que en `CatalogService`.
     */
    @InjectModel(User.name)
    private readonly userModel: Model<unknown>,
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
      .populate({ path: 'invitedBy', select: 'name', model: this.userModel })
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
    linkToken: string,
  ): Promise<{ email: string; role: string; roleName: string }> {
    return this.inBusinessOf(linkToken, async (rawToken) => {
      const invitation = await this.requireValidToken(rawToken);
      const role = await this.roles.findByKey(invitation.role);
      return {
        email: invitation.email,
        role: invitation.role,
        roleName: role?.name ?? invitation.role,
      };
    });
  }

  /** Acepta la invitación: crea el usuario y devuelve una sesión iniciada. */
  async accept(
    linkToken: string,
    dto: AcceptInvitationDto,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView }> {
    return this.inBusinessOf(linkToken, (rawToken) =>
      this.acceptInBusiness(rawToken, dto),
    );
  }

  private async acceptInBusiness(
    rawToken: string,
    dto: AcceptInvitationDto,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView }> {
    const invitation = await this.requireValidToken(rawToken);

    const existingUser = await this.users.findByEmail(invitation.email);
    if (existingUser) {
      invitation.status = 'accepted';
      invitation.acceptedAt = new Date();
      await invitation.save();
      throw new ConflictException({
        code: INVITATION_ERRORS.EMAIL_TAKEN,
        message: 'Ya existe una cuenta con ese correo.',
      });
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

  /**
   * Ejecuta `fn` dentro de la empresa que indica el enlace.
   *
   * `dbNameForBusiness` es una función pura, así que aceptar una invitación no
   * consulta el control-plane: si ese servicio está caído, la gente igual puede
   * entrar al negocio.
   */
  private inBusinessOf<T>(
    linkToken: string,
    fn: (rawToken: string) => Promise<T>,
  ): Promise<T> {
    const separator = linkToken.indexOf('.');
    if (separator <= 0) {
      // Enlaces emitidos antes de este cambio: solo traen el token, así que no
      // hay forma de saber a qué empresa pertenecen. Se pide un reenvío en vez
      // de un "no válida" que hace pensar que el enlace está corrupto.
      throw new BadRequestException({
        code: INVITATION_ERRORS.LEGACY_LINK,
        message:
          'Este enlace de invitación es de una versión anterior y ya no se ' +
          'puede usar.',
      });
    }
    const businessId = linkToken.slice(0, separator);
    const rawToken = linkToken.slice(separator + 1);
    return TenantContext.run(
      { businessId, dbName: dbNameForBusiness(businessId) },
      () => fn(rawToken),
    );
  }

  private async requireValidToken(
    rawToken: string,
  ): Promise<InvitationDocument> {
    const invitation = await this.invitationModel
      .findOne({ tokenHash: hashToken(rawToken) })
      .exec();
    if (!invitation) {
      throw new NotFoundException({
        code: INVITATION_ERRORS.NOT_FOUND,
        message: 'Este enlace de invitación no existe.',
      });
    }
    // 410 y no 404 en los tres casos siguientes: la invitación EXISTIÓ y ya no
    // sirve, que es información distinta —y accionable— frente a un enlace que
    // nunca existió.
    if (invitation.status === 'revoked') {
      throw new GoneException({
        code: INVITATION_ERRORS.REVOKED,
        message: 'Esta invitación fue cancelada por el administrador.',
      });
    }
    if (invitation.status === 'accepted') {
      throw new GoneException({
        code: INVITATION_ERRORS.ACCEPTED,
        message: 'Esta invitación ya se usó: la cuenta está activa.',
      });
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new GoneException({
        code: INVITATION_ERRORS.EXPIRED,
        message: 'Esta invitación venció.',
      });
    }
    return invitation;
  }

  /**
   * Enlace de aceptación. Lleva la empresa DELANTE del token, separada por un
   * punto, porque quien lo abre todavía no es usuario: no manda `Bearer`, el
   * middleware no abre contexto de empresa y sin él no hay base donde buscar la
   * invitación. Es el mismo problema que el restablecimiento de contraseña
   * resuelve guardando `businessId`; aquí viaja en el propio enlace y así
   * aceptar no depende de leer el control-plane.
   *
   * El id de la empresa no es un secreto (ya viaja en cada JWT) y conocerlo no
   * acerca a nadie a adivinar los 32 bytes aleatorios del token: lo único que
   * hace es decir en qué base mirar.
   */
  private buildInviteUrl(rawToken: string): string {
    const base = (
      this.config.get<string>('APP_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    const { businessId } = TenantContext.currentOrThrow();
    return `${base}/invitacion/${businessId}.${rawToken}`;
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
