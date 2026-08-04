import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { UsersService } from './users.service';
import { UserDocument } from '../infrastructure/schemas/user.schema';
import {
  RefreshToken,
  RefreshTokenDocument,
} from '../infrastructure/schemas/refresh-token.schema';
import {
  TenantContext,
  dbNameForBusiness,
} from '../../../shared/tenancy/tenant-context';
import { DirectoryService } from '../../control/application/directory.service';
import { BusinessService } from '../../control/application/business.service';
import type { BusinessType } from '../../control/domain/control.constants';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUserView {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: string[];
  sedeIds: string[];
  /** Giro del negocio (restaurante | retail). Diferencia la experiencia. */
  tipoNegocio?: BusinessType;
}

interface RefreshPayload {
  sub: string;
  jti: string;
  /** Empresa (tenant) del usuario, para reabrir su contexto al refrescar. */
  biz: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly directory: DirectoryService,
    private readonly businesses: BusinessService,
    @InjectModel(RefreshToken.name)
    private readonly refreshModel: Model<RefreshTokenDocument>,
  ) {}

  async login(
    email: string,
    password: string,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView }> {
    // El login solo pide el correo: el directorio (control-plane) dice a qué
    // empresa/base pertenece, y ahí verificamos las credenciales.
    const entry = await this.directory.findByEmail(email);
    if (!entry) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    return TenantContext.run(
      { businessId: entry.businessId, dbName: entry.dbName },
      async () => {
        const user = await this.users.findByEmail(email);
        if (!user || !user.active) {
          throw new UnauthorizedException('Credenciales inválidas');
        }
        const ok = await this.users.verifyPassword(user, password);
        if (!ok) {
          throw new UnauthorizedException('Credenciales inválidas');
        }
        const tokens = await this.issueTokens(user);
        return { tokens, user: await this.toView(user) };
      },
    );
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.refreshSecret(),
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido');
    }
    if (!payload.biz) {
      // Tokens emitidos antes del modelo multi-empresa: forzar re-login.
      throw new UnauthorizedException('Refresh token inválido');
    }
    return TenantContext.run(
      { businessId: payload.biz, dbName: dbNameForBusiness(payload.biz) },
      async () => {
        const stored = await this.refreshModel
          .findOne({ jti: payload.jti })
          .exec();
        if (
          !stored ||
          stored.revoked ||
          stored.expiresAt.getTime() < Date.now()
        ) {
          throw new UnauthorizedException('Refresh token expirado o revocado');
        }
        // Rotación: el refresh usado se revoca y se emite uno nuevo.
        stored.revoked = true;
        await stored.save();
        const user = await this.users.findById(payload.sub);
        return this.issueTokens(user);
      },
    );
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.refreshSecret(),
      });
      await this.refreshModel
        .updateOne({ jti: payload.jti }, { revoked: true })
        .exec();
    } catch {
      // Token inválido: nada que revocar.
    }
  }

  me(user: UserDocument): Promise<AuthUserView> {
    return this.toView(user);
  }

  /** Emite una sesión (tokens + vista) para un usuario ya resuelto.
   *  Lo usa el flujo de aceptación de invitaciones para auto-loguear. */
  async issueSession(
    user: UserDocument,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView }> {
    const tokens = await this.issueTokens(user);
    return { tokens, user: await this.toView(user) };
  }

  private async issueTokens(user: UserDocument): Promise<AuthTokens> {
    const permissions = await this.users.effectivePermissions(user);
    const sedeIds = user.sedeIds.map((s) => s.toString());
    // La empresa activa viene del contexto (login/registro/refresh la abren).
    const businessId = TenantContext.currentOrThrow().businessId;
    const tipoNegocio = await this.currentTipoNegocio();

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions,
      sedeIds,
      biz: businessId,
      biztype: tipoNegocio,
    });

    const jti = randomUUID();
    const refreshExpires =
      this.config.get<string>('JWT_REFRESH_EXPIRES') ?? '7d';
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, biz: businessId } satisfies RefreshPayload,
      {
        secret: this.refreshSecret(),
        expiresIn: refreshExpires,
      } as JwtSignOptions,
    );
    await this.refreshModel.create({
      jti,
      userId: new Types.ObjectId(user.id),
      expiresAt: this.expiryDate(refreshExpires),
      revoked: false,
    });

    return { accessToken, refreshToken };
  }

  private refreshSecret(): string {
    return (
      this.config.get<string>('JWT_REFRESH_SECRET') ??
      this.config.get<string>('JWT_SECRET') ??
      'dev-refresh-secret'
    );
  }

  private async toView(user: UserDocument): Promise<AuthUserView> {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: await this.users.effectivePermissions(user),
      sedeIds: user.sedeIds.map((s) => s.toString()),
      tipoNegocio: await this.currentTipoNegocio(),
    };
  }

  /**
   * Giro del negocio activo. Lo trae el contexto (claim `biztype` del token o el
   * `TenantContext.run` del registro); si aún no está —p. ej. login/refresh, que
   * abren el contexto solo con la empresa— se resuelve del control-plane.
   */
  private async currentTipoNegocio(): Promise<BusinessType | undefined> {
    const ctx = TenantContext.current();
    if (!ctx) return undefined;
    if (ctx.tipoNegocio) return ctx.tipoNegocio;
    const business = await this.businesses.findById(ctx.businessId);
    return business?.tipoNegocio;
  }

  /** Convierte "7d" / "15m" / "24h" / "3600" a una fecha de expiración. */
  private expiryDate(expires: string): Date {
    const match = /^(\d+)([smhd])?$/.exec(expires.trim());
    const now = Date.now();
    if (!match) {
      return new Date(now + 7 * 24 * 3600 * 1000);
    }
    const amount = Number(match[1]);
    const unit = match[2] ?? 's';
    const seconds =
      unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    return new Date(now + amount * seconds * 1000);
  }
}
