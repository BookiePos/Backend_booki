import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

interface InvitationEmail {
  to: string;
  inviteUrl: string;
  roleName: string;
  inviterName?: string;
}

export interface MailResult {
  sent: boolean;
  id?: string;
  error?: string;
}

/**
 * Envío de correos vía Resend. Si no hay RESEND_API_KEY configurada, no falla:
 * registra el correo (y el enlace) en el log para poder copiarlo a mano.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('MailService');
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    this.from =
      this.config.get<string>('MAIL_FROM') ?? 'onboarding@resend.dev';
    this.resend = apiKey ? new Resend(apiKey) : null;
    if (!this.resend) {
      this.logger.warn(
        'RESEND_API_KEY no configurada: los correos se registrarán en el log en vez de enviarse.',
      );
    }
  }

  async sendInvitation(msg: InvitationEmail): Promise<MailResult> {
    const subject = 'Te invitaron a unirte al Sistema POS';
    if (!this.resend) {
      this.logger.log(
        `[correo simulado] Invitación para ${msg.to} (rol: ${msg.roleName}). Enlace: ${msg.inviteUrl}`,
      );
      return { sent: false };
    }
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: msg.to,
        subject,
        html: this.invitationHtml(msg),
      });
      if (error) {
        this.logger.error(`Resend rechazó el envío a ${msg.to}: ${error.message}`);
        return { sent: false, error: error.message };
      }
      this.logger.log(`Invitación enviada a ${msg.to} (id: ${data?.id})`);
      return { sent: true, id: data?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo enviando invitación a ${msg.to}: ${message}`);
      return { sent: false, error: message };
    }
  }

  private invitationHtml(msg: InvitationEmail): string {
    const inviter = msg.inviterName
      ? `${escapeHtml(msg.inviterName)} te invitó`
      : 'Te invitaron';
    return `<!doctype html>
<html lang="es"><body style="margin:0;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#201f1d;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="background:#ffffff;border:1px solid #e8e4de;border-radius:16px;padding:32px;">
      <div style="width:40px;height:40px;border-radius:8px;background:#3f4a5a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;">S</div>
      <h1 style="font-size:22px;margin:24px 0 8px;font-weight:600;">Únete al Sistema POS</h1>
      <p style="font-size:15px;line-height:1.5;color:#4b4842;margin:0 0 8px;">
        ${inviter} a unirte con el rol <strong>${escapeHtml(msg.roleName)}</strong>.
      </p>
      <p style="font-size:15px;line-height:1.5;color:#4b4842;margin:0 0 24px;">
        Haz clic en el botón para elegir tu contraseña y activar tu cuenta.
      </p>
      <a href="${msg.inviteUrl}" style="display:inline-block;background:#3f4a5a;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:10px;">
        Aceptar invitación
      </a>
      <p style="font-size:13px;line-height:1.5;color:#8a857c;margin:24px 0 0;">
        O copia este enlace en tu navegador:<br>
        <a href="${msg.inviteUrl}" style="color:#5b7196;word-break:break-all;">${msg.inviteUrl}</a>
      </p>
      <p style="font-size:13px;color:#8a857c;margin:16px 0 0;">
        Si no esperabas esta invitación, puedes ignorar este correo.
      </p>
    </div>
  </div>
</body></html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
