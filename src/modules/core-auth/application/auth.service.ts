import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
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
import { jwtRefreshSecret } from '../../../shared/config/jwt-secrets';
import { IntentosLoginService } from './intentos-login.service';
import type { BusinessType } from '../../control/domain/control.constants';
import {
  effectiveEntitlements,
  type BusinessPlan,
  type Entitlements,
} from '../../control/domain/plans';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUserView {
  id: string;
  email: string;
  /** Nombre de usuario para login, si el usuario se creó con uno. */
  username?: string;
  name: string;
  role: string;
  permissions: string[];
  sedeIds: string[];
  /** Giro del negocio (restaurante | retail). Diferencia la experiencia. */
  tipoNegocio?: BusinessType;
  /** Plan comercial vigente del tenant. */
  plan?: BusinessPlan;
  /** Features y cuotas efectivas (plan + complementos). */
  entitlements?: Entitlements;
}

interface RefreshPayload {
  sub: string;
  jti: string;
  /** Empresa (tenant) del usuario, para reabrir su contexto al refrescar. */
  biz: string;
  /**
   * Tipo de token (ítem 3.7). Opcional en la lectura solo por los refresh
   * emitidos antes de este cambio; ver `verifyRefresh`.
   */
  typ?: 'refresh';
}

/**
 * Margen para reutilizar un refresh recién rotado sin que cuente como robo
 * (ítem 4.9).
 *
 * El frontend no serializa los refresh: `authFetch` (Frontend/src/lib/api-admin.ts)
 * llama a `apiRefresh()` en cada 401, y una pantalla que dispara varias
 * peticiones a la vez con el access vencido manda varios refresh con LA MISMA
 * cookie. El primero rota; los demás llegan con un token ya revocado. Sin
 * margen, cada carga de un tablero tras 15 minutos de inactividad cerraría
 * todas las sesiones del usuario. Dentro del margen se responde 401 sin más
 * (como hasta ahora: esa petición falla, la cookie nueva ya quedó puesta por
 * la ganadora y la siguiente funciona). Fuera de él, el token rotado solo
 * puede venir de una copia: se revocan todas las sesiones del usuario.
 *
 * No se reemite un par nuevo dentro del margen: eso dejaría al ladrón que
 * llegue a tiempo con una sesión válida y paralela.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * Hash bcrypt de una contraseña aleatoria que nadie conoce (se generó una vez y
 * se descartó), contra el que se compara cuando la cuenta no existe (ítem 4.9).
 * Así un correo desconocido tarda lo mismo que uno registrado con la
 * contraseña mal.
 *
 * Es un literal ya calculado y no `bcrypt.hash` perezoso: calcularlo la primera
 * vez hacía que el primer correo inexistente de cada instancia (serverless:
 * muchas instancias frías) pagara hash + compare, el doble, y eso delataba.
 * No es un secreto: no protege nada, solo gasta tiempo.
 *
 * Tiene 10 rondas, las mismas que `BCRYPT_ROUNDS` de `users.service.ts`; si
 * cambian allí, regenéralo aquí o el tiempo vuelve a delatar (lo vigila
 * `auth.service.login.spec.ts`).
 */
export const HASH_FICTICIO =
  '$2b$10$szVAI/rvZ9L11o4.BQGLnO/c0yiLsQGrlQH6HIXwWjCQPHo3NXKBe'; // secretos-ok: hash señuelo, no es credencial
function compararContraFicticio(password: string): Promise<boolean> {
  return bcrypt.compare(password, HASH_FICTICIO);
}

const CREDENCIALES_INVALIDAS = 'Credenciales inválidas';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly directory: DirectoryService,
    private readonly businesses: BusinessService,
    @InjectModel(RefreshToken.name)
    private readonly refreshModel: Model<RefreshTokenDocument>,
    private readonly intentos: IntentosLoginService,
  ) {}

  async login(
    identifier: string,
    password: string,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView }> {
    // El login acepta correo o nombre de usuario. El directorio (control-plane)
    // dice a qué empresa/base pertenece, y ahí verificamos las credenciales.
    const id = identifier.trim().toLowerCase();
    // Ítem 4.3: bloqueo temporal por cuenta, antes de tocar el directorio.
    await this.intentos.assertNoBloqueada(id);
    const isEmail = id.includes('@');
    const entry = isEmail
      ? await this.directory.findByEmail(id)
      : await this.directory.findByUsername(id);
    // Ítem 4.9: todos los rechazos pagan exactamente una comparación bcrypt y
    // dicen lo mismo. Si no, el tiempo de respuesta delata qué cuentas existen.
    if (!entry) {
      await compararContraFicticio(password);
      await this.intentos.registrarFallo(id);
      throw new UnauthorizedException(CREDENCIALES_INVALIDAS);
    }
    return TenantContext.run(
      { businessId: entry.businessId, dbName: entry.dbName },
      async () => {
        const user = isEmail
          ? await this.users.findByEmail(id)
          : await this.users.findByUsername(id);
        if (!user) {
          await compararContraFicticio(password);
          await this.intentos.registrarFallo(id);
          throw new UnauthorizedException(CREDENCIALES_INVALIDAS);
        }
        // Se compara antes de mirar `active`: el inactivo tarda lo mismo que
        // el activo con la contraseña mal.
        const ok = await this.users.verifyPassword(user, password);
        if (!ok || !user.active) {
          await this.intentos.registrarFallo(id);
          throw new UnauthorizedException(CREDENCIALES_INVALIDAS);
        }
        await this.intentos.limpiar(id);
        const tokens = await this.issueTokens(user);
        return { tokens, user: await this.toView(user) };
      },
    );
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.verifyRefresh(refreshToken);
    if (!payload) {
      throw new UnauthorizedException('Refresh token inválido');
    }
    return TenantContext.run(
      { businessId: payload.biz, dbName: dbNameForBusiness(payload.biz) },
      async () => {
        const now = new Date();
        const userId = new Types.ObjectId(payload.sub);
        // Ítem 4.9: rotación atómica. Antes era `findOne` + `save`: dos
        // refresh simultáneos con el mismo token leían los dos `revoked:
        // false` y los dos emitían sesión. Ahora solo uno reclama la fila.
        const claimed = await this.refreshModel
          .findOneAndUpdate(
            {
              jti: payload.jti,
              userId,
              revoked: false,
              expiresAt: { $gt: now },
            },
            { $set: { revoked: true, rotatedAt: now } },
          )
          .exec();
        if (!claimed) {
          await this.detectarReutilizacion(payload, userId, now);
          throw new UnauthorizedException('Refresh token expirado o revocado');
        }
        // Ítem 3.2: el login ya rechazaba al inactivo, pero aquí no se miraba y
        // un refresh de 7 días le seguía renovando la sesión al desactivado.
        // Un usuario borrado es lo mismo: 401, no el 404 de `findById`.
        const user = await this.users
          .findById(payload.sub)
          .catch(() => null);
        if (!user || !user.active) {
          throw new UnauthorizedException('Refresh token expirado o revocado');
        }
        return this.issueTokens(user);
      },
    );
  }

  /**
   * Ítem 4.9: un refresh que ya fue ROTADO y vuelve a presentarse pasado el
   * margen de gracia solo puede ser una copia (lo usó el legítimo y ahora el
   * ladrón, o al revés). No se sabe cuál de los dos tiene la sesión vigente,
   * así que se cortan todas las del usuario y ambos vuelven a entrar; el
   * legítimo puede, el ladrón no.
   *
   * Un token revocado por cierre de sesión o por cambio de contraseña no lleva
   * `rotatedAt` y no dispara nada: una pestaña vieja no debe echar al usuario
   * de todos sus dispositivos.
   */
  private async detectarReutilizacion(
    payload: RefreshPayload,
    userId: Types.ObjectId,
    now: Date,
  ): Promise<void> {
    const fila = await this.refreshModel
      .findOne({ jti: payload.jti, userId })
      .exec();
    const rotadoHace = fila?.rotatedAt
      ? now.getTime() - fila.rotatedAt.getTime()
      : undefined;
    if (rotadoHace === undefined || rotadoHace <= REFRESH_REUSE_GRACE_MS) {
      return;
    }
    this.logger.warn(
      `Reutilización de refresh rotado (empresa ${payload.biz}, usuario ${payload.sub}, ` +
        `rotado hace ${rotadoHace} ms): se revocan todas sus sesiones`,
    );
    await this.users.revokeAllSessions(payload.sub);
  }

  /**
   * Revoca el refresh token que se está cerrando.
   *
   * La empresa se toma del PROPIO token, igual que en `refresh`, y no del
   * contexto que abrió el middleware. Son dos cosas distintas: el contexto sale
   * del access token, y si ese no trae empresa (tokens anteriores al modelo
   * multi-empresa) el modelo es un proxy inerte, `updateOne` ni siquiera es una
   * función y el `catch` de abajo se tragaba el TypeError. El cierre de sesión
   * respondía 204 y el refresh token seguía sirviendo: la sesión no se cerraba
   * de verdad.
   *
   * Solo se ignora el token ilegible; un fallo al revocar sí se propaga, para
   * no volver a decir "sesión cerrada" cuando no lo está.
   */
  async logout(refreshToken: string): Promise<void> {
    const payload = await this.verifyRefresh(refreshToken);
    if (!payload) {
      // Ilegible, vencido, sin empresa, sin jti o de otro tipo: no hay nada
      // que revocar.
      return;
    }
    await TenantContext.run(
      { businessId: payload.biz, dbName: dbNameForBusiness(payload.biz) },
      () =>
        this.refreshModel
          .updateOne({ jti: payload.jti }, { revoked: true })
          .exec(),
    );
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

  /**
   * Revoca todas las sesiones abiertas de un usuario. Lo usa la recuperación de
   * contraseña: el refresh emitido con la contraseña vieja deja de servir.
   * Debe llamarse dentro del `TenantContext` de la empresa del usuario.
   *
   * Delega en `UsersService`, que también lo necesita al editar un usuario
   * (ítem 3.2) y no puede depender de este servicio sin un ciclo.
   */
  revokeAllSessions(userId: string): Promise<void> {
    return this.users.revokeAllSessions(userId);
  }

  private async issueTokens(user: UserDocument): Promise<AuthTokens> {
    const permissions = await this.users.effectivePermissions(user);
    const sedeIds = user.sedeIds.map((s) => s.toString());
    // La empresa activa viene del contexto (login/registro/refresh la abren).
    const businessId = TenantContext.currentOrThrow().businessId;
    const tipoNegocio = await this.currentTipoNegocio();

    const jti = randomUUID();
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions,
      sedeIds,
      biz: businessId,
      biztype: tipoNegocio,
      sid: jti,
      typ: 'access',
    });

    const refreshExpires =
      this.config.get<string>('JWT_REFRESH_EXPIRES') ?? '7d';
    const refreshToken = await this.jwt.signAsync(
      {
        sub: user.id,
        jti,
        biz: businessId,
        typ: 'refresh',
      } satisfies RefreshPayload,
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
    return jwtRefreshSecret(this.config);
  }

  /**
   * Verifica un refresh token y exige lo que `refresh` y `logout` necesitan
   * (ítem 3.7). Devuelve `null` si no sirve, sin distinguir por qué.
   *
   * - `jti` obligatorio: sin él, `findOne({jti: undefined})` casa con
   *   cualquier fila y `updateOne` revocaría la sesión de otro.
   * - `typ` distinto de `'refresh'` se rechaza: un access token no se acepta
   *   como refresh aunque los secretos coincidieran.
   * - `typ` AUSENTE se acepta mientras vivan los refresh emitidos antes de este
   *   cambio (`JWT_REFRESH_EXPIRES`, 7 días). Es seguro porque los secretos ya
   *   son distintos por obligación: un access nunca pasa esta firma. Exigirlo
   *   desde el despliegue echaría a todos los usuarios de golpe.
   *   PENDIENTE: pasados 7 días desde el despliegue, exigir `typ === 'refresh'`.
   * - `biz` obligatorio: los tokens anteriores al modelo multi-empresa no dicen
   *   en qué base está su sesión.
   *
   * El secreto se lee FUERA del `try`: un entorno mal configurado debe dar un
   * error visible, no hacerse pasar por "token inválido".
   */
  private async verifyRefresh(token: string): Promise<RefreshPayload | null> {
    const secret = this.refreshSecret();
    let payload: Partial<Omit<RefreshPayload, 'typ'>> & { typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret });
    } catch {
      return null;
    }
    if (payload.typ !== undefined && payload.typ !== 'refresh') return null;
    if (typeof payload.jti !== 'string' || payload.jti === '') return null;
    if (typeof payload.biz !== 'string' || payload.biz === '') return null;
    if (
      typeof payload.sub !== 'string' ||
      !Types.ObjectId.isValid(payload.sub)
    ) {
      return null;
    }
    return payload as RefreshPayload;
  }

  private async toView(user: UserDocument): Promise<AuthUserView> {
    const ctx = TenantContext.current();
    const business = ctx ? await this.businesses.findById(ctx.businessId) : null;
    const entitlements = business
      ? effectiveEntitlements(business.plan, business.addOns)
      : ctx?.plan
        ? effectiveEntitlements(ctx.plan, ctx.addOns)
        : undefined;
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
      permissions: await this.users.effectivePermissions(user),
      sedeIds: user.sedeIds.map((s) => s.toString()),
      tipoNegocio: business?.tipoNegocio ?? ctx?.tipoNegocio,
      plan: entitlements?.plan,
      entitlements,
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
