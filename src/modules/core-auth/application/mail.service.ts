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

interface ConfirmacionRegistroEmail {
  to: string;
  confirmUrl: string;
  businessName: string;
  expiresHours: number;
}

interface CuentaExistenteEmail {
  to: string;
  loginUrl: string;
  recoverUrl: string;
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
        `[correo simulado] Invitación para ${msg.to} (rol: ${msg.roleName}). Enlace: ${this.enlaceParaLog(msg.inviteUrl)}`,
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
        `[correo simulado] Recuperación de contraseña para ${msg.to}. Enlace: ${this.enlaceParaLog(msg.resetUrl)}`,
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

  /** Enlace para confirmar el correo y crear la empresa (ítem 4.11). */
  async sendConfirmacionRegistro(
    msg: ConfirmacionRegistroEmail,
  ): Promise<MailResult> {
    return this.enviar(
      msg.to,
      'Confirma tu correo para crear tu cuenta de BookiPos',
      this.confirmacionRegistroHtml(msg),
      `Confirmación de registro para ${msg.to}. Enlace: ${this.enlaceParaLog(msg.confirmUrl)}`,
    );
  }

  /**
   * Aviso a quien ya tiene cuenta y alguien intentó registrarse con su correo.
   * El registro responde igual en los dos casos; la diferencia solo la ve el
   * dueño del buzón.
   */
  async sendAvisoCuentaExistente(msg: CuentaExistenteEmail): Promise<MailResult> {
    return this.enviar(
      msg.to,
      'Ya tienes una cuenta de BookiPos con este correo',
      this.cuentaExistenteHtml(msg),
      `Aviso de cuenta existente para ${msg.to}.`,
    );
  }

  /**
   * El enlace del correo simulado lleva un token de un solo uso. En desarrollo
   * se imprime para copiarlo a mano; en producción no (ítem 4.11): quien lea
   * los logs podría restablecer la contraseña de cualquiera.
   */
  private enlaceParaLog(url: string): string {
    const entorno = this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    return entorno === 'production' ? '[oculto en producción]' : url;
  }

  /** Envío común: sin proveedor se registra en el log; nunca lanza. */
  private async enviar(
    to: string,
    subject: string,
    html: string,
    simulado: string,
  ): Promise<MailResult> {
    if (!this.resend) {
      this.logger.log(`[correo simulado] ${simulado}`);
      return { sent: false, simulated: true };
    }
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.from,
        to,
        subject,
        html,
      });
      if (error) {
        this.logger.error(`Resend rechazó «${subject}» a ${to}: ${error.message}`);
        return { sent: false, error: error.message };
      }
      this.logger.log(`«${subject}» enviado a ${to} (id: ${data?.id})`);
      return { sent: true, id: data?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fallo enviando «${subject}» a ${to}: ${message}`);
      return { sent: false, error: message };
    }
  }

  private confirmacionRegistroHtml(msg: ConfirmacionRegistroEmail): string {
    const url = escapeHtml(msg.confirmUrl);
    return `<!doctype html>
<html lang="es"><body style="margin:0;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#201f1d;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="background:#ffffff;border:1px solid #e8e4de;border-radius:16px;padding:32px;">
      <div style="width:40px;height:40px;border-radius:8px;background:#3f4a5a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;">B</div>
      <h1 style="font-size:22px;margin:24px 0 8px;font-weight:600;">Confirma tu correo</h1>
      <p style="font-size:15px;line-height:1.5;color:#4b4842;margin:0 0 24px;">
        Recibimos la solicitud para crear <strong>${escapeHtml(msg.businessName)}</strong>
        en BookiPos. Haz clic en el botón para confirmar tu correo y entrar.
        El enlace vence en <strong>${msg.expiresHours} horas</strong>.
      </p>
      <a href="${url}" style="display:inline-block;background:#3f4a5a;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:10px;">
        Confirmar y crear mi cuenta
      </a>
      <p style="font-size:13px;line-height:1.5;color:#8a857c;margin:24px 0 0;">
        O copia este enlace en tu navegador:<br>
        <a href="${url}" style="color:#5b7196;word-break:break-all;">${url}</a>
      </p>
      <p style="font-size:13px;color:#8a857c;margin:16px 0 0;">
        Si no fuiste tú, ignora este correo: sin confirmar no se crea nada.
      </p>
    </div>
  </div>
</body></html>`;
  }

  private cuentaExistenteHtml(msg: CuentaExistenteEmail): string {
    const login = escapeHtml(msg.loginUrl);
    const recover = escapeHtml(msg.recoverUrl);
    return `<!doctype html>
<html lang="es"><body style="margin:0;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#201f1d;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="background:#ffffff;border:1px solid #e8e4de;border-radius:16px;padding:32px;">
      <div style="width:40px;height:40px;border-radius:8px;background:#3f4a5a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;">B</div>
      <h1 style="font-size:22px;margin:24px 0 8px;font-weight:600;">Ya tienes una cuenta</h1>
      <p style="font-size:15px;line-height:1.5;color:#4b4842;margin:0 0 24px;">
        Alguien intentó crear una cuenta de BookiPos con este correo, que ya está
        registrado. Si fuiste tú, inicia sesión; si no recuerdas la contraseña,
        puedes cambiarla.
      </p>
      <a href="${login}" style="display:inline-block;background:#3f4a5a;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 24px;border-radius:10px;">
        Iniciar sesión
      </a>
      <p style="font-size:13px;line-height:1.5;color:#8a857c;margin:24px 0 0;">
        ¿Olvidaste la contraseña? <a href="${recover}" style="color:#5b7196;">Recupérala aquí</a>.
      </p>
      <p style="font-size:13px;color:#8a857c;margin:16px 0 0;">
        Si no fuiste tú, ignora este correo: tu cuenta sigue igual y nadie entró en ella.
      </p>
    </div>
  </div>
</body></html>`;
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
