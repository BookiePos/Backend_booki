import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Ítem 4.11: sin RESEND_API_KEY el correo se «simula» en el log. El enlace
 * lleva un token de un solo uso, así que en producción no se imprime.
 */
function servicio(nodeEnv: string) {
  const config = {
    get: (k: string) => (k === 'NODE_ENV' ? nodeEnv : undefined),
  };
  return new MailService(config as never);
}

describe('MailService · correo simulado', () => {
  afterEach(() => vi.restoreAllMocks());

  it('en producción no escribe el token en el log', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const mail = servicio('production');
    await mail.sendPasswordReset({
      to: 'x@y.co',
      resetUrl: 'https://h/recuperar/TOKENFICTICIO',
      userName: 'X',
      expiresMinutes: 60,
    });
    await mail.sendInvitation({ to: 'x@y.co', inviteUrl: 'https://h/invitacion/b.TOKENFICTICIO', roleName: 'Cajero' });
    await mail.sendConfirmacionRegistro({
      to: 'x@y.co',
      confirmUrl: 'https://h/registro/confirmar/TOKENFICTICIO',
      businessName: 'N',
      expiresHours: 24,
    });
    const escrito = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(escrito).not.toContain('TOKENFICTICIO');
    expect(escrito).toContain('[oculto en producción]');
  });

  it('en desarrollo sí lo escribe, para copiarlo a mano', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await servicio('development').sendPasswordReset({
      to: 'x@y.co',
      resetUrl: 'https://h/recuperar/TOKENFICTICIO',
      userName: 'X',
      expiresMinutes: 60,
    });
    expect(String(log.mock.calls[0]?.[0])).toContain('TOKENFICTICIO');
  });
});
