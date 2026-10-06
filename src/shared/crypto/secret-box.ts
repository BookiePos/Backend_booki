import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Cifrado simétrico para secretos que BookiPos tiene que poder volver a leer
 * (por ejemplo, el token con el que cada empresa firma en el facturador).
 *
 * AES-256-GCM: además de ocultar el valor, detecta si alguien lo alteró en la
 * base. La llave sale del entorno y nunca se guarda junto al dato; quien robe
 * la base sin el entorno solo ve ruido.
 *
 * Formato guardado: `v1:<iv>:<tag>:<cifrado>`, en base64. El prefijo de
 * versión deja cambiar de algoritmo sin romper lo ya guardado.
 */
export class SecretBox {
  private readonly key: Buffer;

  /**
   * @param secret llave del entorno. Se deriva con SHA-256 para aceptar
   *   cualquier texto largo sin exigir exactamente 32 bytes.
   */
  constructor(secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error(
        'La llave de cifrado debe tener al menos 32 caracteres.',
      );
    }
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, tag, enc].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join(':');
  }

  open(sealed: string): string {
    const [version, iv, tag, enc] = sealed.split(':');
    if (version !== 'v1' || !iv || !tag || !enc) {
      throw new Error('Secreto cifrado con un formato desconocido.');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(enc, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
