import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { TenantContext } from '../../../shared/tenancy/tenant-context';

vi.mock('./sale-returns.service', () => ({ SaleReturnsService: class {} }));
vi.mock('../../control/application/business.service', () => ({ BusinessService: class {} }));

import { DevolucionesVaradasBarrido } from './devoluciones-varadas.barrido';

/**
 * Barrido de devoluciones varadas (N2): recorre las empresas activas y, dentro
 * del contexto de CADA una (los modelos son proxies inertes fuera de él),
 * completa sus devoluciones en curso.
 */
describe('DevolucionesVaradasBarrido', () => {
  const empresa = (n: number) => ({ _id: new Types.ObjectId(), dbName: `biz_${n}`, tipoNegocio: 'tienda' });

  it('completa empresa por empresa, cada una en su propio contexto', async () => {
    const empresas = [empresa(1), empresa(2)];
    const vistas: (string | undefined)[] = [];
    const returns = {
      completarVaradas: vi.fn(async () => {
        vistas.push(TenantContext.current()?.dbName);
        return { completadas: 1, pendientesCaja: 0, fallidas: 0, ocupadas: 0 };
      }),
    };
    const barrido = new DevolucionesVaradasBarrido(
      { listActive: async () => empresas } as never,
      returns as never,
    );
    const r = await barrido.barrer();
    expect(r.estado).toBe('ok');
    expect(r.cifras).toMatchObject({ empresas: 2, completadas: 2 });
    expect(vistas.sort()).toEqual(['biz_1', 'biz_2']);
  });

  it('una devolución que sigue en curso pone el barrido en error (el cron sale en rojo)', async () => {
    const barrido = new DevolucionesVaradasBarrido(
      { listActive: async () => [empresa(1)] } as never,
      { completarVaradas: async () => ({ completadas: 0, pendientesCaja: 0, fallidas: 1, ocupadas: 0 }) } as never,
    );
    const r = await barrido.barrer();
    expect(r.estado).toBe('error');
    expect(r.detalle).toContain('siguen en curso');
  });

  it('las pendientes de caja no son error del cron: se reportan en el detalle (N6)', async () => {
    const barrido = new DevolucionesVaradasBarrido(
      { listActive: async () => [empresa(1), empresa(2)] } as never,
      { completarVaradas: async () => ({ completadas: 0, pendientesCaja: 2, fallidas: 0, ocupadas: 0 }) } as never,
    );
    const r = await barrido.barrer();
    expect(r.estado).toBe('ok');
    expect(r.detalle).toBe('pendientes de caja: 4');
    expect(r.cifras).toMatchObject({ pendientesCaja: 4 });
  });

  it('nunca lanza: el fallo de una empresa se reporta y las demás siguen', async () => {
    const llamadas = vi.fn()
      .mockRejectedValueOnce(new Error('base caída'))
      .mockResolvedValueOnce({ completadas: 1, pendientesCaja: 0, fallidas: 0, ocupadas: 0 });
    const barrido = new DevolucionesVaradasBarrido(
      { listActive: async () => [empresa(1), empresa(2)] } as never,
      { completarVaradas: llamadas } as never,
    );
    const r = await barrido.barrer();
    expect(r.estado).toBe('error');
    expect(llamadas).toHaveBeenCalledTimes(2);
  });
});
