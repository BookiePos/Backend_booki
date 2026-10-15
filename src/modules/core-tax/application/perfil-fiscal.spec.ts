import { describe, it, expect, vi } from 'vitest';
import { ivaDescontablePorSede, perfilFiscalDeSede } from './perfil-fiscal';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

/**
 * Ítem 1.17: el perfil fiscal se lee por sede con las responsabilidades del
 * RUT. Un restaurante con una sede en franquicia descuenta IVA solo en esa.
 */
describe('perfil fiscal por sede (ítem 1.17)', () => {
  const sedes = [
    { _id: 'propia', responsabilidadFiscal: 'responsable_iva' },
    { _id: 'franquicia', responsabilidadFiscal: 'responsable_iva', franquicia: true },
  ];
  const fuentes = {
    sedes: {
      find: () => ({ select: () => ({ exec: async () => sedes }) }),
      findById: (id: string) => ({
        select: () => ({ exec: async () => sedes.find((s) => s._id === id) ?? null }),
      }),
    },
    businesses: { findById: vi.fn() },
  } as never;

  const enRestaurante = <T>(fn: () => Promise<T>) =>
    TenantContext.run(
      { businessId: 'b1', dbName: 'biz_b1', tipoNegocio: 'restaurante' } as never,
      fn,
    );

  it('la franquicia descuenta IVA; la sede propia (INC) no', async () => {
    const admite = await enRestaurante(() => ivaDescontablePorSede(fuentes));
    expect(admite('franquicia')).toBe(true);
    expect(admite('propia')).toBe(false);
  });

  it('el perfil de la sede trae las responsabilidades explícitas', async () => {
    const perfil = await enRestaurante(() => perfilFiscalDeSede(fuentes, 'franquicia'));
    expect(perfil).toMatchObject({ tipoNegocio: 'restaurante', franquicia: true });
  });
});
