import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { UsersService } from './users.service';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { DirectoryService } from '../../control/application/directory.service';
import { CONTROL_CONNECTION } from '../../control/domain/control.constants';
import {
  PasswordReset,
  PasswordResetDocument,
} from '../../control/infrastructure/schemas/password-reset.schema';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/** Minutos de validez del enlace si no se configura otra cosa. */
const DEFAULT_EXPIRES_MINUTES = 60;

/** Espera mínima entre dos correos de recuperación para el mismo usuario. */
const RESEND_COOLDOWN_MS = 60_000;

/**
 * Recuperación de contraseña por correo.
 *
 * Dos reglas gobiernan todo el flujo:
 *
 * 1. **No revelamos si una cuenta existe.** `request()` responde igual haya
 *    usuario o no; solo cambia lo que ocurre por dentro. Si respondiéramos
 *    distinto, el formulario sería un oráculo para enumerar clientes.
 * 2. **El token en claro solo existe en el correo.** En la base guardamos su
 *    SHA-256, y al usarlo se marca como consumido y se cierran todas las
 *    sesiones abiertas del usuario: si alguien entró con la contraseña vieja,
 *    la recuperación lo echa.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordResetService');

  constructor(
    @InjectModel(PasswordReset.name, CONTROL_CONNECTION)
    private readonly resets: Model<PasswordResetDocument>,
    private readonly directory: DirectoryService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Pide un enlace de recuperación. Acepta correo o nombre de usuario, igual
   * que el login. Nunca lanza por "no existe": el controlador responde 202 en
   * todos los casos.
   */
  async request(identifier: string): Promise<void> {
    const id = identifier.trim().toLowerCase();
    const isEmail = id.includes('@');
    const entry = isEmail
      ? await this.directory.findByEmail(id)
      : await this.directory.findByUsername(id);
    if (!entry) return;

    await TenantContext.run(
      { businessId: entry.businessId, dbName: entry.dbName },
      async () => {
        const user = isEmail
          ? await this.users.findByEmail(id)
          : await this.users.findByUsername(id);
        if (!user || !user.active) return;

        // Los usuarios creados solo con nombre de usuario llevan un correo
        // sintético `<usuario>@<businessId>.local` que no existe en ningún
        // buzón. A esos no se les puede enviar nada: su contraseña la
        // restablece el dueño desde el panel.
        const email = user.email.toLowerCase();
        if (email.endsWith('.local')) {
          this.logger.warn(
            `Recuperación pedida para "${id}", que no tiene correo real. ` +
              'Debe restablecerla el administrador desde el panel.',
          );
          return;
        }

        // Antifloods: si acabamos de mandar uno, no mandamos otro. El límite por
        // IP del controlador no cubre el caso de pedirlo desde muchas IPs para
        // llenarle el buzón a alguien.
        const recent = await this.resets
          .findOne({ userId: user.id, usedAt: { $exists: false } })
          .sort({ createdAt: -1 })
          .exec();
        const createdAt = (recent as unknown as { createdAt?: Date } | null)
          ?.createdAt;
        if (
          recent &&
          recent.expiresAt.getTime() > Date.now() &&
          createdAt &&
          Date.now() - createdAt.getTime() < RESEND_COOLDOWN_MS
        ) {
          return;
        }

        // Un solo enlace vivo por usuario: pedir otro invalida el anterior.
        await this.resets
          .deleteMany({ userId: user.id, usedAt: { $exists: false } })
          .exec();

        const rawToken = randomBytes(32).toString('hex');
        await this.resets.create({
          email,
          businessId: entry.businessId,
          dbName: entry.dbName,
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt: this.expiryDate(),
        });

        await this.mail.sendPasswordReset({
          to: email,
          resetUrl: this.buildResetUrl(rawToken),
          userName: user.name,
          expiresMinutes: this.expiresMinutes(),
        });
      },
    );
  }

  /** Valida el enlace (pantalla de nueva contraseña) sin consumirlo. */
  async validate(rawToken: string): Promise<{ email: string }> {
    const reset = await this.requireValidToken(rawToken);
    return { email: reset.email };
  }

  /** Aplica la nueva contraseña, consume el enlace y cierra las sesiones. */
  async reset(rawToken: string, password: string): Promise<void> {
    const reset = await this.requireValidToken(rawToken);

    await TenantContext.run(
      { businessId: reset.businessId, dbName: reset.dbName },
      async () => {
        const user = await this.users.findById(reset.userId);
        await this.users.setPassword(user, password);
        // Cambiar la contraseña invalida lo emitido antes: si la cuenta estaba
        // comprometida, el intruso pierde el acceso aunque tenga un refresh.
        await this.auth.revokeAllSessions(user.id);
      },
    );

    reset.usedAt = new Date();
    await reset.save();
  }

  // ---- helpers ----

  private async requireValidToken(
    rawToken: string,
  ): Promise<PasswordResetDocument> {
    const reset = await this.resets
      .findOne({ tokenHash: hashToken(rawToken) })
      .exec();
    if (!reset) {
      throw new NotFoundException('El enlace de recuperación no es válido');
    }
    if (reset.usedAt) {
      throw new GoneException('Este enlace ya se usó. Pide uno nuevo.');
    }
    if (reset.expiresAt.getTime() < Date.now()) {
      throw new GoneException('El enlace expiró. Pide uno nuevo.');
    }
    return reset;
  }

  private buildResetUrl(rawToken: string): string {
    const base = (
      this.config.get<string>('APP_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    return `${base}/recuperar/${rawToken}`;
  }

  private expiresMinutes(): number {
    const raw = Number(
      this.config.get<string>('PASSWORD_RESET_EXPIRES_MINUTES') ??
        DEFAULT_EXPIRES_MINUTES,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPIRES_MINUTES;
  }

  private expiryDate(): Date {
    return new Date(Date.now() + this.expiresMinutes() * 60_000);
  }
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
