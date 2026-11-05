import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

const consolidar = vi.fn();
vi.mock('../domain/nomina/consolidar', () => ({ consolidarNominaMes: (e: unknown) => consolidar(e) }));

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LOTE_EMISION_MAX, NominaPeriodoService } from './nomina-periodo.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

const SEDE = new Types.ObjectId();
const OTRA_SEDE = new Types.ObjectId();
const E1 = new Types.ObjectId();
const E2 = new Types.ObjectId();
const E3 = new Types.ObjectId();
const owner = { userId: 'u', email: 'o@x.co', name: 'O', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;
const soloOtra = { ...owner, role: 'cashier', sedeIds: [OTRA_SEDE.toString()] } as unknown as JwtUser;
const EMISOR = { _id: new Types.ObjectId(), nitNorm: '900123456', razonSocial: 'X SAS', nitDv: '7', direccion: 'Cl 1', municipioDane: '05001' };

const slip = (id: Types.ObjectId, nombre: string) => ({ employeeId: id.toString(), employeeName: nombre, diasTrabajados: 30, breakdown: {} });
const run = (status: string, ids: [Types.ObjectId, string][], sedeId: Types.ObjectId = SEDE) => ({
  _id: new Types.ObjectId(),
  period: '2026-10',
  coverage: 'sede',
  status,
  sedeId,
  slips: ids.map(([i, n]) => slip(i, n)),
});
const emp = (id: Types.ObjectId, doc: string) => {
  const o = { _id: id, docNumber: doc, firstName: 'N', lastName: 'A', sedeId: SEDE };
  return { ...o, toObject: () => o };
};
const lean = <T>(v: T) => ({ lean: () => ({ exec: async () => v }), exec: async () => v, sort: () => ({ exec: async () => v }) });

function armar(corridas: any[], docs: any[] = []) {
  const emitir = vi.fn(async (modelo: any) => ({
    documentoId: new Types.ObjectId().toString(),
    fullNumber: 'NE1',
    dianStatus: 'accepted',
    transmitido: true,
    mensajes: [],
    intentos: 1,
    _modelo: modelo,
  }));
  const docsModel = {
    find: () => lean(docs),
    findById: (id: string) => ({ exec: async () => docs.find((d) => String(d._id) === id) ?? null }),
    findOne: () => lean(docs[0] ?? null),
    updateOne: () => ({ exec: async () => undefined }),
  };
  const s = new NominaPeriodoService(
    docsModel as any,
    { find: () => lean(corridas) } as any,
    { find: () => lean([]) } as any,
    { find: () => lean([{ _id: SEDE }]) } as any,
    { list: async () => [emp(E1, '111'), emp(E2, '222'), emp(E3, '333')] } as any,
    { obtenerPorSede: async () => EMISOR } as any,
    { emitir } as any,
    { record: async () => undefined } as any,
  );
  return { s, emitir };
}
const dentro = <T>(f: () => Promise<T>) => TenantContext.run({ businessId: 'b1' } as any, f);

beforeEach(() => {
  consolidar.mockReset();
  consolidar.mockReturnValue({ ok: true, modelo: { trabajador: {} }, advertencias: ['aviso'], recorte: {} });
});

describe('NominaPeriodoService.preparar', () => {
  it('lista por trabajador de corridas CERRADAS, con bloqueos y advertencias, sin emitir', async () => {
    const { s, emitir } = armar([run('cerrada', [[E1, 'Ana'], [E2, 'Beto']]), run('borrador', [[E3, 'Carla']])]);
    consolidar.mockImplementation((e: any) =>
      e.empleado.id === E2.toString() ? { ok: false, bloqueos: ['falta EPS'] } : { ok: true, modelo: {}, advertencias: ['aviso'], recorte: {} },
    );
    const r = await dentro(() => s.preparar('2026-10', SEDE.toString(), owner));
    expect(r.trabajadores.map((t) => t.empleadoId)).toEqual([E1.toString(), E2.toString()].sort());
    const ana = r.trabajadores.find((t) => t.nombre === 'Ana')!;
    const beto = r.trabajadores.find((t) => t.nombre === 'Beto')!;
    expect(ana).toMatchObject({ ok: true, advertencias: ['aviso'], bloqueos: [] });
    expect(beto).toMatchObject({ ok: false, bloqueos: ['falta EPS'] });
    expect(emitir).not.toHaveBeenCalled();
  });

  it('marca el documento existente del trabajador', async () => {
    const doc = { _id: new Types.ObjectId(), fullNumber: 'NE5', dianStatus: 'accepted', empleado: { docNumber: '111' } };
    const { s } = armar([run('cerrada', [[E1, 'Ana']])], [doc]);
    const r = await dentro(() => s.preparar('2026-10', SEDE.toString(), owner));
    expect(r.trabajadores[0]!.documentoExistente).toMatchObject({ fullNumber: 'NE5', dianStatus: 'accepted' });
  });

  it('sede ajena: 403; periodo mal formado: 400; sin sedeId: 400', async () => {
    const { s } = armar([]);
    await expect(dentro(() => s.preparar('2026-10', SEDE.toString(), soloOtra))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dentro(() => s.preparar('2026-13', SEDE.toString(), owner))).rejects.toBeInstanceOf(BadRequestException);
    await expect(dentro(() => s.preparar('2026-10', '', owner))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignora corridas de sedes fuera del emisor', async () => {
    const { s } = armar([run('cerrada', [[E1, 'Ana']], OTRA_SEDE)]);
    const r = await dentro(() => s.preparar('2026-10', SEDE.toString(), owner));
    expect(r.trabajadores).toHaveLength(0);
  });
});

describe('NominaPeriodoService.emitir', () => {
  const corridas = () => [run('cerrada', [[E1, 'Ana'], [E2, 'Beto'], [E3, 'Carla']])];

  it('emite en lotes con cursor y reporta pendientes', async () => {
    const { s, emitir } = armar(corridas());
    const r1 = await dentro(() => s.emitir('2026-10', SEDE.toString(), owner, { limite: 2 }));
    expect(r1.resultados).toHaveLength(2);
    expect(r1.pendientes).toBe(1);
    expect(r1.siguienteCursor).toBeDefined();
    const r2 = await dentro(() => s.emitir('2026-10', SEDE.toString(), owner, { cursor: r1.siguienteCursor, limite: 2 }));
    expect(r2.resultados).toHaveLength(1);
    expect(r2.pendientes).toBe(0);
    expect(r2.siguienteCursor).toBeUndefined();
    expect(emitir).toHaveBeenCalledTimes(3);
  });

  it('acota el lote al máximo', async () => {
    const { s } = armar(corridas());
    const r = await dentro(() => s.emitir('2026-10', SEDE.toString(), owner, { limite: 999 }));
    expect(r.resultados.length).toBeLessThanOrEqual(LOTE_EMISION_MAX);
  });

  it('idempotente: un 102 ya aceptado se devuelve y no se vuelve a emitir', async () => {
    const doc = { _id: new Types.ObjectId(), fullNumber: 'NE9', dianStatus: 'accepted', empleado: { docNumber: '111' } };
    const { s, emitir } = armar([run('cerrada', [[E1, 'Ana']])], [doc]);
    const r = await dentro(() => s.emitir('2026-10', SEDE.toString(), owner));
    expect(r.resultados[0]).toMatchObject({ estado: 'existente', fullNumber: 'NE9' });
    expect(emitir).not.toHaveBeenCalled();
  });

  it('un trabajador bloqueado no se emite y los demás sí', async () => {
    const { s, emitir } = armar(corridas());
    consolidar.mockImplementation((e: any) =>
      e.empleado.id === E2.toString() ? { ok: false, bloqueos: ['borrador'] } : { ok: true, modelo: {}, advertencias: [], recorte: {} },
    );
    const r = await dentro(() => s.emitir('2026-10', SEDE.toString(), owner));
    expect(r.resultados.filter((x) => x.estado === 'bloqueado')).toHaveLength(1);
    expect(emitir).toHaveBeenCalledTimes(2);
  });

  it('un error de un trabajador no tumba el lote', async () => {
    const { s, emitir } = armar(corridas());
    emitir.mockRejectedValueOnce(new ConflictException('ajuste en curso'));
    const r = await dentro(() => s.emitir('2026-10', SEDE.toString(), owner));
    expect(r.resultados.filter((x) => x.estado === 'error')).toHaveLength(1);
    expect(r.resultados).toHaveLength(3);
  });

  it('sede ajena: 403 y no emite', async () => {
    const { s, emitir } = armar(corridas());
    await expect(dentro(() => s.emitir('2026-10', SEDE.toString(), soloOtra))).rejects.toBeInstanceOf(ForbiddenException);
    expect(emitir).not.toHaveBeenCalled();
  });
});

describe('NominaPeriodoService.listar', () => {
  it('no expone el documento completo del trabajador ni datos sensibles', async () => {
    const doc = {
      _id: new Types.ObjectId(), fullNumber: 'NE1', tipoXml: '102', periodo: '2026-10', dianStatus: 'accepted',
      issueDate: '2026-10-31', vigente: true, empleado: { name: 'Ana', docNumber: '1017123456' }, cune: 'SECRETO', xmlPath: 'p',
    };
    const { s } = armar([], [doc]);
    const r = await dentro(() => s.listar('2026-10', SEDE.toString(), owner));
    expect(r[0]!.empleado.documento).toBe('••••3456');
    expect(JSON.stringify(r)).not.toContain('SECRETO');
    expect(JSON.stringify(r)).not.toContain('1017123456');
  });

  it('sede ajena: 403', async () => {
    const { s } = armar([]);
    await expect(dentro(() => s.listar('2026-10', SEDE.toString(), soloOtra))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('NominaPeriodoService.ajustar', () => {
  const cabeza = (extra: object = {}) => ({
    _id: new Types.ObjectId(), sedeId: SEDE, periodo: '2026-10', fullNumber: 'NE1', cune: 'cune1', issueDate: '2026-10-31',
    dianStatus: 'accepted', vigente: true, tipoXml: '102', empleado: { docNumber: '111' }, ...extra,
  });

  it('eliminar emite un 103 tipo 2 contra el último aceptado', async () => {
    const d = cabeza();
    const { s, emitir } = armar([run('cerrada', [[E1, 'Ana']])], [d]);
    await dentro(() => s.ajustar(String(d._id), 'eliminar', owner));
    expect(emitir.mock.calls[0]![0]).toMatchObject({ tipoNota: 2, predecesor: { numero: 'NE1', cune: 'cune1' } });
    expect(consolidar).not.toHaveBeenCalled();
  });

  it('reemplazar recalcula desde las corridas actuales y emite un 103 tipo 1', async () => {
    const d = cabeza();
    const { s, emitir } = armar([run('cerrada', [[E1, 'Ana']])], [d]);
    consolidar.mockReturnValue({ ok: true, modelo: { nuevo: true }, advertencias: [], recorte: {} });
    await dentro(() => s.ajustar(String(d._id), 'reemplazar', owner));
    expect(consolidar).toHaveBeenCalledTimes(1);
    expect(emitir.mock.calls[0]![0]).toMatchObject({ tipoNota: 1, documento: { nuevo: true } });
  });

  it('reemplazar con bloqueos del consolidador: 409 y no emite', async () => {
    const d = cabeza();
    const { s, emitir } = armar([run('cerrada', [[E1, 'Ana']])], [d]);
    consolidar.mockReturnValue({ ok: false, bloqueos: ['corrida en borrador'] });
    await expect(dentro(() => s.ajustar(String(d._id), 'reemplazar', owner))).rejects.toBeInstanceOf(ConflictException);
    expect(emitir).not.toHaveBeenCalled();
  });

  it('documento de otra sede: 403; inexistente: 404', async () => {
    const d = cabeza({ sedeId: OTRA_SEDE });
    const { s, emitir } = armar([], [d]);
    await expect(dentro(() => s.ajustar(String(d._id), 'eliminar', { ...owner, role: 'cashier', sedeIds: [SEDE.toString()] } as unknown as JwtUser))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(dentro(() => s.ajustar(new Types.ObjectId().toString(), 'eliminar', owner))).rejects.toThrow(/no encontrado/);
    expect(emitir).not.toHaveBeenCalled();
  });
});
