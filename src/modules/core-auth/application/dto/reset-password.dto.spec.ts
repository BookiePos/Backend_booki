import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResetPasswordDto } from './reset-password.dto';
import { RegisterDto } from './register.dto';

/**
 * Ítem 4.9: recuperar la contraseña no puede ser la puerta trasera de la
 * política. El registro exige 8 caracteres con mayúscula, minúscula, número y
 * símbolo; el reset pedía 6 de cualquier cosa, así que bastaba con "olvidar"
 * la contraseña para quedarse con una débil.
 */
async function erroresDe<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errores = await validate(plainToInstance(cls, body));
  return errores.map((e) => e.property);
}

describe('ResetPasswordDto · misma política que el registro', () => {
  it.each(['abc123', 'abcdefgh', 'Abcdefgh', 'Abcdefg1', 'abcdef1!'])(
    'rechaza "%s"',
    async (password) => {
      expect(await erroresDe(ResetPasswordDto, { password })).toContain(
        'password',
      );
    },
  );

  it('acepta una contraseña que el registro también acepta', async () => {
    expect(await erroresDe(ResetPasswordDto, { password: 'Abcdef1!' })).toEqual(
      [],
    );
  });

  it('cualquier contraseña que el registro rechaza, el reset también', async () => {
    for (const password of ['abc123', 'Abcdefg1', 'ABCDEF1!', 'Ab1!']) {
      const registro = (
        await erroresDe(RegisterDto, { password })
      ).includes('password');
      const reset = (await erroresDe(ResetPasswordDto, { password })).includes(
        'password',
      );
      expect({ password, reset }).toEqual({ password, reset: registro });
    }
  });
});
