import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { RangosDianService } from './rangos-dian.service';
import { AmbienteNoCoincideError } from './transmision-dian.puertos';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const SEDE = 'a'.repeat(24);
const user = (sedeIds = [SEDE]) =>
  ({ userId: 'u1', email: 'a@b.co', name: 'Ana', role: 'Dueño', sedeIds, permissions: [] }) as unknown as JwtUser;

function montar(opts: { emisor?: object | null; rangos?: object[]; para?: () => Promise<unknown> } = {}) {
  const claveOculta = { desde: 1, hasta: 100, prefijo: 'FE', resolucion: '1876', fechaResolucion: '2026-01-01', vigenciaDesde: '2026-01-02', vigenciaHasta: '2028-01-02' };
  Object.defineProperty(claveOculta, 'claveTecnica', { value: 'SECRETA', enumerable: false });
  const transmisor = {
    rangos: vi.fn(async () => ({
      ok: true,
      codigo: '0',
      origen: 'dian',
      mensajes: ['ok'],
      rangos: opts.rangos ?? [claveOculta, { desde: 1, hasta: 50, prefijo: 'POS', resolucion: '999' }],
    })),
  };
  const emisores = {
    obtenerPorSede: vi.fn(async () =>
      opts.emisor === undefined ? { id: 'em1', nitNorm: '900123', tipoAmbiente: '2' } : opts.emisor,
    ),
  };
  const sedes = { findOrFail: vi.fn(async () => ({ resolucionFe: { numero: '1876', prefijo: 'FE', rangoDesde: 1, rangoHasta: 100 }, resolucionesFe: [] })) };
  const proveedor = { para: vi.fn(opts.para ?? (async () => transmisor)) };
  const audit = { record: vi.fn(async (_r: unknown) => undefined) };
  const svc = new RangosDianService(emisores as never, sedes as never, proveedor as never, audit as never);
  return { svc, transmisor, proveedor, audit };
}

describe('RangosDianService', () => {
  it('trae los rangos, marca los ya registrados y no deja salir la clave técnica', async () => {
    const m = montar();
    const r = await m.svc.traer(SEDE, user());
    expect(r.ok).toBe(true);
    expect(r.rangos).toEqual([
      { desde: 1, hasta: 100, prefijo: 'FE', resolucion: '1876', fechaResolucion: '2026-01-01', vigenciaDesde: '2026-01-02', vigenciaHasta: '2028-01-02', registrada: true },
      { desde: 1, hasta: 50, prefijo: 'POS', resolucion: '999', registrada: false },
    ]);
    expect(JSON.stringify(r)).not.toContain('SECRETA');
    expect(m.transmisor.rangos).toHaveBeenCalledWith('900123');
    expect(m.audit.record.mock.calls[0]![0]).toMatchObject({ action: 'einvoicing.rangos.consulta', success: true });
  });
  it('sede ajena: 403 y no se consulta nada', async () => {
    const m = montar();
    await expect(m.svc.traer(SEDE, user(['b'.repeat(24)]))).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.proveedor.para).not.toHaveBeenCalled();
  });
  it('sin emisor fiscal: 400', async () => {
    const m = montar({ emisor: null });
    await expect(m.svc.traer(SEDE, user())).rejects.toBeInstanceOf(BadRequestException);
  });
  it('si el ambiente cambió responde CONFIG_FALTANTE sin llamar a la DIAN', async () => {
    const m = montar({
      para: async () => {
        throw new AmbienteNoCoincideError();
      },
    });
    const r = await m.svc.traer(SEDE, user());
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('CONFIG_FALTANTE');
    expect(m.transmisor.rangos).not.toHaveBeenCalled();
  });
  it('la misma resolución con otro tramo no cuenta como registrada', async () => {
    const m = montar({ rangos: [{ desde: 101, hasta: 200, prefijo: 'FE', resolucion: '1876' }] });
    const r = await m.svc.traer(SEDE, user());
    expect(r.rangos[0]!.registrada).toBe(false);
  });
  it('claveTecnicaDe devuelve la clave del rango que coincide y solo en el servidor', async () => {
    const m = montar();
    const q = { numero: '1876', prefijo: 'FE', desde: 1, hasta: 100 };
    const r = await m.svc.claveTecnicaDe(SEDE, q, user());
    expect(r!.claveTecnica).toBe('SECRETA');
    expect(r!.vigenciaHasta).toBe('2028-01-02');
    expect(await m.svc.claveTecnicaDe(SEDE, { ...q, hasta: 99 }, user())).toBeUndefined();
    await expect(m.svc.claveTecnicaDe(SEDE, q, user(['b'.repeat(24)]))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
