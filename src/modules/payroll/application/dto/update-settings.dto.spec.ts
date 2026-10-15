import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePayrollSettingsDto } from './update-settings.dto';

/**
 * Ítem 1.8 (H5): cada tramo de jornada se valida. Un `desde` mal escrito
 * («2026-7-15») se compara como texto y cambia en silencio qué tramo rige; una
 * jornada de 0 o de 60 h no existe en el art. 161 CST.
 */
async function errores(jornadaTramos: unknown): Promise<number> {
  const dto = plainToInstance(UpdatePayrollSettingsDto, { jornadaTramos });
  return (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).length;
}

describe('UpdatePayrollSettingsDto.jornadaTramos', () => {
  it('acepta pactos bien formados y la tabla vacía', async () => {
    expect(await errores([{ desde: '2024-01-01', horasSemana: 40 }])).toBe(0);
    expect(await errores([])).toBe(0);
  });

  it.each([
    [{ desde: '2026-7-15', horasSemana: 40 }],
    [{ desde: '2026-07-15', horasSemana: 0 }],
    [{ desde: '2026-07-15', horasSemana: 49 }],
    [{ desde: '2026-07-15', horasSemana: 40.5 }],
    [{ desde: '2026-07-15' }],
    [{ desde: '2026-07-15', horasSemana: 40, extra: 1 }],
  ])('rechaza el tramo %j', async (tramo) => {
    expect(await errores([tramo])).toBeGreaterThan(0);
  });
});
