import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

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

import {
  EinvoicingAccountsService,
  normalizeNit,
} from './einvoicing-accounts.service';
import { SecretBox } from '../../../shared/crypto/secret-box';

/**
 * La conexión de cada NIT con el facturador: aquí se decide con qué
 * certificado firma la empresa. El token se guarda cifrado, el certificado no
 * se guarda, y nadie configura un NIT de una sede que no ve.
 *
 * Constructor: (accounts, provider, sedes, config).
 */
describe('EinvoicingAccountsService', () => {
  const LLAVE = 'llave-de-prueba-de-al-menos-treinta-y-dos-caracteres';
  const user = { email: 'duena@x.co', sedeIds: ['s1'], permissions: [] } as any;

  let cuentas: Record<string, any>;
  let provider: any;
  let model: any;

  const sede = {
    id: 's1',
    code: 'S1',
    name: 'Centro',
    nit: '900.123.456-8',
    nitDv: '8',
    businessName: 'Arepas SAS',
    address: 'Calle 33',
    phone: '6044445566',
    emailFacturacion: 'f@arepas.co',
    departamento: 'Antioquia',
    ciudad: 'Medellín',
  };

  function build(over: { secret?: string; requiresAccount?: boolean } = {}) {
    cuentas = {};
    provider = {
      name: 'apidian',
      enabled: true,
      requiresAccount: over.requiresAccount ?? true,
      configureCompany: vi.fn().mockResolvedValue({ token: 'token-secreto-123' }),
      configureCertificate: vi.fn().mockResolvedValue({ expiresAt: '2027-10-01T00:00:00' }),
      configureSoftware: vi.fn(),
      setEnvironment: vi.fn(),
    };
    const doc = (nit: string) => {
      const d = cuentas[nit];
      return d ? Object.assign(d, { save: vi.fn().mockResolvedValue(d) }) : null;
    };
    model = {
      findOne: vi.fn((q: any) => ({ exec: () => Promise.resolve(doc(q.nit)) })),
      find: vi.fn(() => ({ exec: () => Promise.resolve(Object.values(cuentas)) })),
      findOneAndUpdate: vi.fn((q: any, u: any) => ({
        exec: () => {
          cuentas[q.nit] = {
            nit: q.nit,
            ...(cuentas[q.nit] ? {} : u.$setOnInsert),
            ...cuentas[q.nit],
            ...u.$set,
          };
          return Promise.resolve(cuentas[q.nit]);
        },
      })),
      updateOne: vi.fn(() => ({ exec: () => Promise.resolve({}) })),
    };
    return new EinvoicingAccountsService(
      model,
      provider,
      {
        list: vi.fn().mockResolvedValue([sede]),
        findOrFail: vi.fn().mockResolvedValue(sede),
      } as never,
      { get: vi.fn(() => over.secret ?? LLAVE) } as never,
    );
  }

  beforeEach(() => vi.clearAllMocks());

  it('normaliza el NIT: sin puntos ni DV', () => {
    expect(normalizeNit('900.123.456-8')).toBe('900123456');
    expect(normalizeNit(undefined)).toBe('');
  });

  it('al conectar la empresa guarda el token CIFRADO, nunca en claro', async () => {
    const svc = build();

    await svc.registerCompany('s1', user);

    const guardado = cuentas['900123456'];
    expect(guardado.tokenSealed).not.toContain('token-secreto');
    expect(new SecretBox(LLAVE).open(guardado.tokenSealed)).toBe('token-secreto-123');
    expect(guardado.step).toBe('certificado');
  });

  it('la vista de la conexión no expone el token', async () => {
    const svc = build();
    await svc.registerCompany('s1', user);

    const [vista] = await svc.list(user);

    expect(JSON.stringify(vista)).not.toContain('token');
    expect(vista).toMatchObject({ nit: '900123456', connected: true, step: 'certificado' });
  });

  it('el certificado pasa al facturador y solo queda su vencimiento', async () => {
    const svc = build();
    await svc.registerCompany('s1', user);

    await svc.uploadCertificate('900123456', 'QUJD', 'clave-del-p12', user);

    expect(provider.configureCertificate).toHaveBeenCalledWith(
      'token-secreto-123',
      'QUJD',
      'clave-del-p12',
    );
    const guardado = JSON.stringify(cuentas['900123456']);
    expect(guardado).not.toContain('QUJD');
    expect(guardado).not.toContain('clave-del-p12');
    expect(cuentas['900123456'].certificateExpiresAt).toBeInstanceOf(Date);
    expect(cuentas['900123456'].step).toBe('software');
  });

  it('no deja configurar un NIT de una sede que el usuario no ve', async () => {
    const svc = build();

    await expect(
      svc.uploadCertificate('811111111', 'QUJD', 'x', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('si el facturador rechaza, guarda el error para mostrarlo', async () => {
    const svc = build();
    await svc.registerCompany('s1', user);
    provider.configureCertificate.mockRejectedValue(new Error('clave incorrecta'));

    await expect(
      svc.uploadCertificate('900123456', 'QUJD', 'mala', user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cuentas['900123456'].lastError).toBe('clave incorrecta');
  });

  it('no pasa a producción sin haber hecho la habilitación', async () => {
    const svc = build();
    await svc.registerCompany('s1', user);

    await expect(
      svc.setEnvironment('900123456', 'produccion', user),
    ).rejects.toThrow(/set de pruebas/);
    expect(provider.setEnvironment).not.toHaveBeenCalled();
  });

  describe('conexión para emitir', () => {
    it('sin cuenta no hay conexión: la emisión debe frenar', async () => {
      const svc = build();

      expect(await svc.connectionFor('900123456')).toBeUndefined();
    });

    it('con la empresa creada pero sin certificado ni software, todavía no emite', async () => {
      const svc = build();
      await svc.registerCompany('s1', user);

      expect(await svc.connectionFor('900123456')).toBeUndefined();
    });

    it('con la habilitación hecha entrega el token descifrado y el ambiente', async () => {
      const svc = build();
      await svc.registerCompany('s1', user);
      cuentas['900123456'].step = 'set_pruebas';

      const conn = await svc.connectionFor('900.123.456-8');

      expect(conn).toMatchObject({ token: 'token-secreto-123', environment: 'habilitacion' });
    });

    it('el proveedor simulado no exige cuenta', async () => {
      const svc = build({ requiresAccount: false });

      expect(await svc.connectionFor(undefined)).toMatchObject({ environment: 'habilitacion' });
    });
  });

  it('sin llave de cifrado en el servidor, no guarda credenciales', async () => {
    const svc = build({ secret: '' });

    await expect(svc.registerCompany('s1', user)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Ni siquiera crea la empresa allá: su token se perdería.
    expect(provider.configureCompany).not.toHaveBeenCalled();
  });
});
