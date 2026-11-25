import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { PayrollService } from './payroll.service';

/**
 * Los valores de ley (salario mínimo, auxilio, recargos) rigen para toda la
 * empresa. Quien solo maneja la nómina de una sede no puede cambiarlos: se
 * rechaza antes de leer o escribir nada.
 */
describe('PayrollService.actualizarValoresLey: alcance', () => {
  it('un usuario limitado a una sede recibe 403 y no se toca ningún parámetro', async () => {
    const params = { tieneVigenciaEn: vi.fn(), setVigente: vi.fn(), number: vi.fn() };
    const service = new PayrollService(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, params as any, {} as any,
    );
    const deSede = { role: 'gerente', permissions: ['payroll.manage'], sedeIds: ['s1'], email: 'g@x.co' } as any;
    await expect(
      service.actualizarValoresLey({ vigenteDesde: '2027-01-01', smmlv: 1_900_000 } as any, deSede),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(params.tieneVigenciaEn).not.toHaveBeenCalled();
  });
});
