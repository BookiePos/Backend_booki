import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConflictException, Logger } from '@nestjs/common';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { ReconsultaDianService } from './reconsulta-dian.service';
import { TransmisionDianService } from './transmision-dian.service';
import { NominaElectronicaService } from './nomina-electronica.service';
import { HabilitacionNominaService } from './habilitacion-nomina.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { REPOSO_RECONSULTA_MS, cifrasVacias } from '../domain/reconsulta';

const biz = (id: string) => ({ _id: { toString: () => id }, dbName: `biz_${id}`, tipoNegocio: 'retail' });
const cifras = (p: Partial<ReturnType<typeof cifrasVacias>> = {}) => ({ ...cifrasVacias(), ...p });

describe('ReconsultaDianService.barrer', () => {
  const businesses = { listActive: vi.fn() };
  const transmision = { reconsultarPendientes: vi.fn() };
  const nomina = { reconsultarPendientes: vi.fn() };
  const habilitacion = { avanzarEnCurso: vi.fn() };
  const servicio = () =>
    new ReconsultaDianService(businesses as never, transmision as never, nomina as never, habilitacion as never);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    transmision.reconsultarPendientes.mockResolvedValue(cifras());
    nomina.reconsultarPendientes.mockResolvedValue(cifras());
    habilitacion.avanzarEnCurso.mockResolvedValue(cifras());
  });

  it('recorre cada empresa dentro de su TenantContext', async () => {
    businesses.listActive.mockResolvedValue([biz('a'), biz('b')]);
    const vistas: string[] = [];
    transmision.reconsultarPendientes.mockImplementation(async () => {
      vistas.push(TenantContext.currentOrThrow().businessId);
      return cifras({ revisados: 1, avanzados: 1 });
    });
    const r = await servicio().barrer();
    expect(r.estado).toBe('ok');
    expect(vistas.sort()).toEqual(['a', 'b']);
    expect(r.cifras).toMatchObject({ empresas: 2, procesadas: 2, revisados: 2, avanzados: 2, facturasRevisadas: 2 });
    expect(nomina.reconsultarPendientes).toHaveBeenCalledTimes(2);
    expect(habilitacion.avanzarEnCurso).toHaveBeenCalledTimes(2);
  });

  it('pasa el tope por empresa (10 por defecto) y el plazo global', async () => {
    businesses.listActive.mockResolvedValue([biz('a')]);
    const hasta = Date.now() + 100_000;
    await servicio().barrer({ hasta });
    expect(transmision.reconsultarPendientes).toHaveBeenCalledWith(10, expect.objectContaining({ hasta }));
    await servicio().barrer({ hasta, limitePorEmpresa: 3 });
    expect(nomina.reconsultarPendientes).toHaveBeenLastCalledWith(3, expect.objectContaining({ hasta }));
  });

  it('un fallo en una empresa no frena a las demás, pero el barrido sale en error', async () => {
    businesses.listActive.mockResolvedValue([biz('a'), biz('b'), biz('c')]);
    transmision.reconsultarPendientes.mockImplementation(async () => {
      if (TenantContext.currentOrThrow().businessId === 'a') throw new Error('Mongo caído');
      return cifras({ revisados: 1 });
    });
    const r = await servicio().barrer();
    expect(r.estado).toBe('error');
    expect(r.cifras).toMatchObject({ procesadas: 3, fallidas: 1, revisados: 2 });
  });

  it('errores inesperados por documento hacen fallar la corrida; los omitidos no', async () => {
    businesses.listActive.mockResolvedValue([biz('a')]);
    nomina.reconsultarPendientes.mockResolvedValue(cifras({ revisados: 2, omitidos: 2 }));
    expect((await servicio().barrer()).estado).toBe('ok');
    nomina.reconsultarPendientes.mockResolvedValue(cifras({ revisados: 1, errores: 1 }));
    expect((await servicio().barrer()).estado).toBe('error');
  });

  it('con el plazo vencido no empieza empresas y las reporta pendientes', async () => {
    businesses.listActive.mockResolvedValue([biz('a'), biz('b')]);
    const r = await servicio().barrer({ hasta: Date.now() - 1 });
    expect(r.estado).toBe('error');
    expect(r.cifras).toMatchObject({ pendientes: 2, procesadas: 0 });
    expect(transmision.reconsultarPendientes).not.toHaveBeenCalled();
  });

  it('no se solapa consigo mismo', async () => {
    businesses.listActive.mockResolvedValue([biz('a')]);
    let soltar!: () => void;
    transmision.reconsultarPendientes.mockImplementation(() => new Promise((res) => (soltar = () => res(cifras()))));
    const s = servicio();
    const primera = s.barrer();
    await new Promise((r) => setTimeout(r, 5));
    expect((await s.barrer()).estado).toBe('omitido');
    soltar();
    await primera;
  });
});

describe('reconsultarPendientes de los servicios (camino de sistema)', () => {
  const ahora = new Date('2026-11-05T12:00:00Z');
  const ctx = { businessId: 'a', dbName: 'biz_a' };
  const modelo = (ids: string[]) => {
    const find = vi.fn();
    const updateOne = vi.fn(() => ({ exec: async () => undefined }));
    const q: any = {
      sort: vi.fn(() => q),
      limit: vi.fn(() => q),
      select: vi.fn(() => q),
      exec: async () => ids.map((id) => ({ _id: id })),
    };
    find.mockReturnValue(q);
    return { find, q, updateOne };
  };
  const armar = (Clase: any, ids: string[], ejecutar: (id: string) => Promise<any>) => {
    const s = Object.create(Clase.prototype);
    const m = modelo(ids);
    s.model = m;
    s.logger = { error: vi.fn(), warn: vi.fn() };
    s.audit = { record: vi.fn(async () => undefined) };
    s.ejecutar = ejecutar;
    s.cargar = async (id: string) => id;
    s.transmitirExistente = ejecutar;
    return { s, m };
  };
  const filtroDe = (m: ReturnType<typeof modelo>) => (m.find.mock.calls[0] as any[])[0];

  for (const [nombre, Clase] of [
    ['factura', TransmisionDianService],
    ['nómina', NominaElectronicaService],
  ] as const) {
    describe(nombre, () => {
      it('sin TenantContext falla antes de leer nada', async () => {
        const { s, m } = armar(Clase, [], async () => ({}));
        await expect(s.reconsultarPendientes(10, { ahora })).rejects.toBeTruthy();
        expect(m.find).not.toHaveBeenCalled();
      });

      it('solo busca lo que lleva más de 10 min en sent y respeta el tope', async () => {
        const { s, m } = armar(Clase, [], async () => ({}));
        await TenantContext.run(ctx, () => s.reconsultarPendientes(7, { ahora }));
        const f = filtroDe(m);
        expect(f.dianStatus).toBe('sent');
        expect(f.enviadoAt.$lte.getTime()).toBe(ahora.getTime() - REPOSO_RECONSULTA_MS);
        expect(m.q.limit).toHaveBeenCalledWith(7);
        expect(m.q.sort).toHaveBeenCalledWith({ reconsultadoAt: 1, enviadoAt: 1 });
      });

      it('audita como SYSTEM, cuenta avanzados/omitidos/errores y sigue tras un fallo', async () => {
        const { s } = armar(Clase, ['1', '2', '3', '4'], async (id: string) => {
          if (id === '2') throw new ConflictException('gate');
          if (id === '3') throw new Error('boom');
          return { dianStatus: id === '1' ? 'accepted' : 'sent', codigo: '00', intentos: 1 };
        });
        const r = await TenantContext.run(ctx, () => s.reconsultarPendientes(10, { ahora }));
        expect(r).toEqual({ revisados: 4, avanzados: 1, omitidos: 1, errores: 1 });
        const filas = s.audit.record.mock.calls.map((c: any[]) => c[0]);
        expect(filas).toHaveLength(4);
        for (const f of filas) {
          expect(f).toMatchObject({ userName: 'SYSTEM', role: 'SYSTEM', method: 'SERVER' });
          expect(f.userId).toBeUndefined();
        }
      });

      it('no empieza otro documento si no queda margen en el plazo global', async () => {
        const ejecutar = vi.fn(async () => ({ dianStatus: 'sent' }));
        const { s } = armar(Clase, ['1', '2'], ejecutar);
        const r = await TenantContext.run(ctx, () => s.reconsultarPendientes(10, { ahora, hasta: Date.now() + 1000 }));
        expect(ejecutar).not.toHaveBeenCalled();
        expect(r.revisados).toBe(0);
      });
    });
  }

  it('marca reconsultadoAt en cada intento (también omitidos) y ordena por él: 12 docs con 10 atascados', async () => {
    const hechos = new Map<string, number>();
    const { s, m } = armar(TransmisionDianService, [], async () => {
      throw new ConflictException('en vuelo sin XML');
    });
    // Cola simulada: reconsultadoAt nulo primero, luego enviadoAt.
    const docs = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, enviadoAt: i, reconsultadoAt: undefined as number | undefined }));
    const atascados = new Set(docs.slice(0, 10).map((d) => d.id));
    let reloj = 100;
    m.updateOne.mockImplementation(((f: any, u: any) => {
      const d = docs.find((x) => x.id === f._id)!;
      d.reconsultadoAt = u.$set.reconsultadoAt ? ++reloj : undefined;
      hechos.set(d.id, (hechos.get(d.id) ?? 0) + 1);
      return { exec: async () => undefined };
    }) as any);
    m.q.exec = async () =>
      [...docs]
        .sort((a, b) => (a.reconsultadoAt ?? -1) - (b.reconsultadoAt ?? -1) || a.enviadoAt - b.enviadoAt)
        .slice(0, 10)
        .map((d) => ({ _id: d.id }));
    s.ejecutar = async (id: string) => {
      if (atascados.has(id)) throw new ConflictException('en vuelo sin XML');
      return { dianStatus: 'accepted' };
    };
    await TenantContext.run(ctx, () => s.reconsultarPendientes(10, { ahora }));
    const r2 = await TenantContext.run(ctx, () => s.reconsultarPendientes(10, { ahora }));
    expect(hechos.get('d10')).toBe(1);
    expect(hechos.get('d11')).toBe(1);
    expect(r2.avanzados).toBe(2);
    expect(m.q.sort).toHaveBeenCalledWith({ reconsultadoAt: 1, enviadoAt: 1 });
  });

  describe('habilitación de nómina', () => {
    const fila = (estados: string[]) => ({
      sedeId: { toString: () => 'sede' },
      conjunto: { testSetId: 't', documentos: estados.map((estado) => ({ tipo: 'nie', estado })) },
    });
    it('consulta (sin enviar) los sets, con auditoría SYSTEM', async () => {
      const s: any = Object.create(HabilitacionNominaService.prototype);
      s.logger = { error: vi.fn() };
      s.audit = { record: vi.fn(async () => undefined) };
      const llamadas: any[] = [];
      s.correr = async (...a: any[]) => {
        llamadas.push(a);
        return { estado: 'en_curso', documentos: [], resumen: { aceptados: 1 } };
      };
      const q: any = { sort: () => q, exec: async () => [fila(['enviado', 'pendiente'])] };
      s.model = { find: () => q };
      const r = await TenantContext.run(ctx, () => s.avanzarEnCurso(10, { ahora }));
      expect(r.revisados).toBe(1);
      expect(llamadas.every((l) => l[1] === false)).toBe(true);
      expect(s.audit.record.mock.calls[0][0]).toMatchObject({ userName: 'SYSTEM', method: 'SERVER' });
    });
  });
});
