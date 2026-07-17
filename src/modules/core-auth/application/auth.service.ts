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
}

interface RefreshPayload {
  sub: string;
  jti: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectModel(RefreshToken.name)
    private readonly refreshModel: Model<RefreshTokenDocument>,
  ) {}

  async login(
    email: string,
    password: string,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView }> {
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
    const stored = await this.refreshModel.findOne({ jti: payload.jti }).exec();
    if (!stored || stored.revoked || stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expirado o revocado');
    }
    // Rotación: el refresh usado se revoca y se emite uno nuevo.
    stored.revoked = true;
    await stored.save();
    const user = await this.users.findById(payload.sub);
    return this.issueTokens(user);
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

  private async issueTokens(user: UserDocument): Promise<AuthTokens> {
    const permissions = await this.users.effectivePermissions(user);
    const sedeIds = user.sedeIds.map((s) => s.toString());

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      permissions,
      sedeIds,
    });

    const jti = randomUUID();
    const refreshExpires =
      this.config.get<string>('JWT_REFRESH_EXPIRES') ?? '7d';
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti } satisfies RefreshPayload,
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
    };
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
