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
 *
 * Desde 4.11 el alta tiene dos pasos (solicitar y confirmar por correo): los
 * datos viajan en el pendiente, así que aquí se recorren los dos.
 */
const CORTO = {
  businessName: 'Café Aurora',
  plan: 'negocio',
  tipoNegocio: 'restaurante',
  ownerName: 'Ana Ruiz',
  ownerEmail: 'Ana@Aurora.co',
  password: 'Secreta#2026x',
};

const exec = <T>(v: T) => ({ exec: vi.fn().mockResolvedValue(v) });

function makeDeps(tipoNegocio: string) {
  return {
    businesses: {
      nitExists: vi.fn(),
      remove: vi.fn(),
      create: vi.fn(async () => ({
        id: '68b0f3c2a1d4e5f6a7b8c9d0',
        dbName: 'biz_68b0f3c2a1d4e5f6a7b8c9d0',
        tipoNegocio,
        plan: 'negocio',
      })),
    },
    directory: { exists: vi.fn(async () => false), unlink: vi.fn() },
    roles: { ensureSystemRoles: vi.fn() },
    sedes: { create: vi.fn(async () => ({ id: 'sede1' })) },
    users: { create: vi.fn(async () => ({ id: 'u1' })) },
    auth: { issueSession: vi.fn(async () => ({ tokens: {}, user: {} })) },
    pendientes: {
      find: vi.fn().mockReturnValue(exec([])),
      findOne: vi.fn().mockReturnValue(exec(null)),
      findOneAndUpdate: vi.fn().mockReturnValue(exec(null)),
      updateOne: vi.fn().mockReturnValue(exec(undefined)),
      deleteOne: vi.fn().mockReturnValue(exec(undefined)),
    },
    mail: { sendConfirmacionRegistro: vi.fn(async () => ({ sent: true })) },
    config: { get: vi.fn(() => 'https://app.ejemplo.test') },
  };
}

/** Solicita con `extra` y confirma con el pendiente que quedó guardado. */
async function registrar(extra: Record<string, unknown>, tipoNegocio = 'retail') {
  const d = makeDeps(tipoNegocio);
  const service = new RegistrationService(
    d.businesses as any,
    d.directory as any,
    d.roles as any,
    d.sedes as any,
    d.users as any,
    d.auth as any,
    d.pendientes as any,
    d.mail as any,
    d.config as any,
  );

  await service.solicitar(
    plainToInstance(RegisterDto, { ...CORTO, tipoNegocio, ...extra }),
  );
  const { $set } = (d.pendientes.findOneAndUpdate.mock.calls[0] as any[])[1];
  const pendiente = {
    _id: 'p1',
    email: 'ana@aurora.co',
    tokenHash: $set.tokenHash,
    passwordHash: $set.passwordHash,
    datos: $set.datos,
  };
  d.pendientes.findOne.mockReturnValue(exec(pendiente));
  d.pendientes.findOneAndUpdate.mockReturnValue(exec(pendiente));

  const res = await service.confirmar('tok', CORTO.password);
  const sede = (d.sedes.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  return { d, res, sede };
}

describe('registro corto', () => {
  it('el DTO acepta el alta sin ningún dato fiscal', async () => {
    const errores = await validate(plainToInstance(RegisterDto, CORTO));
    expect(errores).toEqual([]);
  });

  it('crea empresa, sede y dueño sin NIT ni responsabilidad fiscal', async () => {
    const { d, res, sede } = await registrar({}, 'restaurante');

    // Sin NIT no se consulta la unicidad del NIT.
    expect(d.businesses.nitExists).not.toHaveBeenCalled();
    expect(res.plan).toBe('negocio');

    expect(sede).toMatchObject({ code: 'principal', businessName: 'Café Aurora' });
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
      expect(sede[campo]).toBeUndefined();
    }
    expect(d.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@aurora.co', sedeIds: ['sede1'] }),
      undefined,
      expect.anything(),
    );
  });

  it('«¿Cobras IVA?» No: la sede nace no responsable y la venta de retail sale sin IVA', async () => {
    const { sede } = await registrar({ cobraIva: 'no' });
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
    expect((await registrar({ cobraIva: 'si' })).sede.responsabilidadFiscal).toBe(
      'responsable_iva',
    );
    expect((await registrar({ cobraIva: 'no_se' })).sede.responsabilidadFiscal).toBeUndefined();
    expect((await registrar({})).sede.responsabilidadFiscal).toBeUndefined();
  });

  it('una responsabilidad fiscal explícita gana sobre la pregunta', async () => {
    const { sede } = await registrar({
      cobraIva: 'no',
      responsabilidadFiscal: 'regimen_simple',
    });
    expect(sede.responsabilidadFiscal).toBe('regimen_simple');
  });

  it('el DTO rechaza un valor de cobraIva desconocido', async () => {
    const errores = await validate(plainToInstance(RegisterDto, { ...CORTO, cobraIva: 'quizas' }));
    expect(errores.map((e) => e.property)).toContain('cobraIva');
  });
});
