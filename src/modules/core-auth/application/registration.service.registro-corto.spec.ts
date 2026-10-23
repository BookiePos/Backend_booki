import { describe, it, expect, vi } from 'vitest';

// Mismo mock que `auth.service.login.spec.ts`: SWC emite `Object` como metadata
// para los @Prop() con uniones de literales y @nestjs/mongoose revienta al
// importar los esquemas.
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from './dto/register.dto';
import { RegistrationService } from './registration.service';
import { saleTaxFor } from '../../core-tax/domain/sale-tax';

/**
 * Ítem 6.5, registro corto: el alta se hace solo con nombre del negocio, giro,
 * plan, nombre y correo del dueño y contraseña. Los datos fiscales (NIT,
 * régimen, dirección…) se piden después; la sede nace sin ellos.
 */
const CORTO = {
  businessName: 'Café Aurora',
  plan: 'negocio',
  tipoNegocio: 'restaurante',
  ownerName: 'Ana Ruiz',
  ownerEmail: 'Ana@Aurora.co',
  password: 'Secreta#2026x',
};

describe('registro corto', () => {
  it('el DTO acepta el alta sin ningún dato fiscal', async () => {
    const errores = await validate(plainToInstance(RegisterDto, CORTO));
    expect(errores).toEqual([]);
  });

  it('crea empresa, sede y dueño sin NIT ni responsabilidad fiscal', async () => {
    const sedeCreada = { id: 'sede1' };
    const businesses = {
      nitExists: vi.fn(),
      create: vi.fn(async () => ({
        id: '68b0f3c2a1d4e5f6a7b8c9d0',
        dbName: 'biz_68b0f3c2a1d4e5f6a7b8c9d0',
        tipoNegocio: 'restaurante',
        plan: 'negocio',
      })),
    };
    const sedes = { create: vi.fn(async () => sedeCreada) };
    const users = { create: vi.fn(async () => ({ id: 'u1' })) };
    const service = new RegistrationService(
      businesses as any,
      { exists: vi.fn(async () => false) } as any,
      { ensureSystemRoles: vi.fn() } as any,
      sedes as any,
      users as any,
      { issueSession: vi.fn(async () => ({ tokens: {}, user: {} })) } as any,
    );

    const dto = plainToInstance(RegisterDto, CORTO);
    const res = await service.register(dto);

    // Sin NIT no se consulta la unicidad del NIT.
    expect(businesses.nitExists).not.toHaveBeenCalled();
    expect(res.plan).toBe('negocio');

    const sedeDto = (sedes.create.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(sedeDto).toMatchObject({ code: 'principal', businessName: 'Café Aurora' });
    for (const campo of [
      'nit',
      'nitDv',
      'responsabilidadFiscal',
      'ciiu',
      'departamento',
      'ciudad',
      'address',
      'phone',
      'emailFacturacion',
    ]) {
      expect(sedeDto[campo]).toBeUndefined();
    }
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@aurora.co', sedeIds: ['sede1'] }),
    );
  });

  async function registrar(extra: Record<string, unknown>) {
    const sedes = { create: vi.fn(async () => ({ id: 'sede1' })) };
    const service = new RegistrationService(
      {
        nitExists: vi.fn(),
        create: vi.fn(async () => ({
          id: '68b0f3c2a1d4e5f6a7b8c9d0',
          dbName: 'biz_68b0f3c2a1d4e5f6a7b8c9d0',
          tipoNegocio: 'retail',
          plan: 'negocio',
        })),
      } as any,
      { exists: vi.fn(async () => false) } as any,
      { ensureSystemRoles: vi.fn() } as any,
      sedes as any,
      { create: vi.fn(async () => ({ id: 'u1' })) } as any,
      { issueSession: vi.fn(async () => ({ tokens: {}, user: {} })) } as any,
    );
    await service.register(
      plainToInstance(RegisterDto, { ...CORTO, tipoNegocio: 'retail', ...extra }),
    );
    return (sedes.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  }

  it('«¿Cobras IVA?» No: la sede nace no responsable y la venta de retail sale sin IVA', async () => {
    const sede = await registrar({ cobraIva: 'no' });
    expect(sede.responsabilidadFiscal).toBe('no_responsable_iva');
    expect(
      saleTaxFor(
        { tipoNegocio: 'retail', responsabilidadFiscal: sede.responsabilidadFiscal as any },
        { ivaType: 'gravado', ivaRate: 19 },
        8,
      ),
    ).toEqual({ kind: 'ninguno', rate: 0 });
  });

  it('«¿Cobras IVA?» Sí: responsable de IVA; No sé o vacío: sin dato (default conservador)', async () => {
    expect((await registrar({ cobraIva: 'si' })).responsabilidadFiscal).toBe('responsable_iva');
    expect((await registrar({ cobraIva: 'no_se' })).responsabilidadFiscal).toBeUndefined();
    expect((await registrar({})).responsabilidadFiscal).toBeUndefined();
  });

  it('una responsabilidad fiscal explícita gana sobre la pregunta', async () => {
    const sede = await registrar({ cobraIva: 'no', responsabilidadFiscal: 'regimen_simple' });
    expect(sede.responsabilidadFiscal).toBe('regimen_simple');
  });

  it('el DTO rechaza un valor de cobraIva desconocido', async () => {
    const errores = await validate(plainToInstance(RegisterDto, { ...CORTO, cobraIva: 'quizas' }));
    expect(errores.map((e) => e.property)).toContain('cobraIva');
  });
});
