import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

interface InvitationEmail {
  to: string;
  inviteUrl: string;
  roleName: string;
  inviterName?: string;
}

interface PasswordResetEmail {
  to: string;
  resetUrl: string;
  userName: string;
  expiresMinutes: number;
}

interface PayslipEmail {
  to: string;
  employeeName: string;
  period: string;
  netoPagar: string;
  employerName: string;
  pdf: Buffer;
  filename: string;
}

export interface MailResult {
  sent: boolean;
  id?: string;
  error?: string;
  /** true cuando no hay proveedor configurado y solo se registró en el log. */
  simulated?: boolean;
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

  /** Envía el enlace para restablecer la contraseña. */
  async sendPasswordReset(msg: PasswordResetEmail): Promise<MailResult> {
    const subject = 'Recupera tu contraseña de BookiPos';
    if (!this.resend) {
      this.logger.log(
        `[correo simulado] Recuperación de contraseña para ${msg.to}. Enlace: ${msg.resetUrl}`,
      );
      return { sent: false, simulated: true };
    }
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: msg.to,
        subject,
        html: this.passwordResetHtml(msg),
      });
      if (error) {
        this.logger.error(
          `Resend rechazó la recuperación a ${msg.to}: ${error.message}`,
        );
        return { sent: false, error: error.message };
      }
      this.logger.log(`Recuperación enviada a ${msg.to} (id: ${data?.id})`);
      return { sent: true, id: data?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo enviando recuperación a ${msg.to}: ${message}`);
      return { sent: false, error: message };
    }
  }

  /** Envía el comprobante de nómina (PDF adjunto) al correo del empleado. */
  async sendPayslip(msg: PayslipEmail): Promise<MailResult> {
    const subject = `Comprobante de nómina · ${msg.period}`;
    if (!this.resend) {
      this.logger.log(
        `[correo simulado] Comprobante de nómina para ${msg.to} ` +
          `(${msg.employeeName}, período ${msg.period}, neto ${msg.netoPagar}). ` +
          `PDF de ${msg.pdf.length} bytes generado.`,
      );
      return { sent: false, simulated: true };
    }
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to: msg.to,
        subject,
        html: this.payslipHtml(msg),
        attachments: [{ filename: msg.filename, content: msg.pdf }],
      });
      if (error) {
        this.logger.error(`Resend rechazó el comprobante a ${msg.to}: ${error.message}`);
        return { sent: false, error: error.message };
      }
      this.logger.log(`Comprobante de nómina enviado a ${msg.to} (id: ${data?.id})`);
      return { sent: true, id: data?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo enviando comprobante a ${msg.to}: ${message}`);
      return { sent: false, error: message };
    }
  }

  private payslipHtml(msg: PayslipEmail): string {
    return `<!doctype html>
<html lang="es"><body style="margin:0;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#201f1d;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="background:#ffffff;border:1px solid #e8e4de;border-radius:16px;padding:32px;">
      <p style="font-size:13px;color:#8a857c;margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(msg.employerName)}</p>
      <h1 style="font-size:20px;margin:0 0 4px;font-weight:600;">Comprobante de nómina</h1>
      <p style="font-size:14px;color:#4b4842;margin:0 0 24px;">Período ${escapeHtml(msg.period)}</p>
      <p style="font-size:15px;line-height:1.5;color:#4b4842;margin:0 0 16px;">
        Hola ${escapeHtml(msg.employeeName)}, adjuntamos tu comprobante de pago de nómina.
      </p>
      <div style="background:#eef1f6;border-radius:10px;padding:16px 20px;margin:0 0 20px;display:flex;justify-content:space-between;">
        <span style="font-size:14px;color:#3f4a5a;font-weight:600;">Neto a pagar</span>
        <span style="font-size:18px;color:#3f4a5a;font-weight:700;">${escapeHtml(msg.netoPagar)}</span>
      </div>
      <p style="font-size:13px;line-height:1.5;color:#8a857c;margin:0;">
        El detalle completo (devengados, deducciones, aportes y provisiones) está en el
        PDF adjunto. Comprobante de pago de salarios (art. 138 CST).
      </p>
    </div>
  </div>
</body></html>`;
  }

  private passwordResetHtml(msg: PasswordResetEmail): string {
    // La URL se escapa aunque la generemos nosotros: lleva un token en la ruta
    // y no debe poder romper el atributo href.
    const resetUrl = escapeHtml(msg.resetUrl);
    return `<!doctype html>
<html lang="es"><body style="margin:0;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#201f1d;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="background:#ffffff;border:1px solid #e8e4de;border-radius:16px;padding:32px;">
      <div style="width:40px;height:40px;border-radius:8px;background:#3f4a5a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;">B</div>
      <h1 style="font-size:22px;margin:24px 0 8px;font-weight:600;">Recupera tu contraseña</h1>
      <p style="font-size:15px;line-height:1.5;color:#4b4842;margin:0 0 8px;">
        Hola ${escapeHtml(msg.userName)}, recibimos una solicitud para restablecer
        la contraseña de tu cuenta de BookiPos.
      </p>
      <p style="font-size:15px;line-height:1.5;color:#4b4842;margin:0 0 24px;">
        Haz clic en el botón para elegir una nueva. El enlace vence en
        <strong>${msg.expiresMinutes} minutos</strong> y solo puede usarse una vez.
      </p>
      <a href="${resetUrl}" style="display:inline-block;background:#3f4a5a;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:10px;">
        Cambiar mi contraseña
      </a>
      <p style="font-size:13px;line-height:1.5;color:#8a857c;margin:24px 0 0;">
        O copia este enlace en tu navegador:<br>
        <a href="${resetUrl}" style="color:#5b7196;word-break:break-all;">${resetUrl}</a>
      </p>
      <p style="font-size:13px;color:#8a857c;margin:16px 0 0;">
        Si no pediste este cambio, ignora este correo: tu contraseña actual sigue
        funcionando y nadie más puede usar este enlace sin tu buzón.
      </p>
    </div>
  </div>
</body></html>`;
  }

  private invitationHtml(msg: InvitationEmail): string {
    const inviter = msg.inviterName
      ? `${escapeHtml(msg.inviterName)} te invitó`
      : 'Te invitaron';
    // La URL de invitación también se escapa: aunque la generamos nosotros,
    // puede llevar querystring y no debe poder romper el atributo href ni
    // inyectar HTML si algún día su origen cambia.
    const inviteUrl = escapeHtml(msg.inviteUrl);
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
      <a href="${inviteUrl}" style="display:inline-block;background:#3f4a5a;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:10px;">
        Aceptar invitación
      </a>
      <p style="font-size:13px;line-height:1.5;color:#8a857c;margin:24px 0 0;">
        O copia este enlace en tu navegador:<br>
        <a href="${inviteUrl}" style="color:#5b7196;word-break:break-all;">${inviteUrl}</a>
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
