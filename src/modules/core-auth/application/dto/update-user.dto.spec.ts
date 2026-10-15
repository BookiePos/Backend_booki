import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

/**
 * Ítem 4.9: editar un usuario tampoco puede ser la puerta trasera de la
 * política de contraseña. Pedía 6 caracteres de cualquier cosa; ahora la misma
 * política que el registro y la recuperación, pero solo cuando viene
 * `password` (la pantalla de usuarios la omite si no se cambia).
 */
async function erroresDe(body: Record<string, unknown>): Promise<string[]> {
  const errores = await validate(plainToInstance(UpdateUserDto, body));
  return errores.map((e) => e.property);
}

describe('UpdateUserDto · contraseña con la política del registro', () => {
  it.each(['abc123', 'abcdefgh', 'Abcdefg1', 'abcdef1!'])(
    'rechaza "%s"',
    async (password) => {
      expect(await erroresDe({ password })).toContain('password');
    },
  );

  it('acepta una contraseña fuerte', async () => {
    expect(await erroresDe({ password: 'Abcdef1!' })).toEqual([]);
  });

  it('sin password no exige nada (editar el nombre no pide contraseña)', async () => {
    expect(await erroresDe({ name: 'Ana' })).toEqual([]);
  });
});
