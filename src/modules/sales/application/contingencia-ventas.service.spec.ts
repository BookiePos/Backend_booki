import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined, virtual: () => ({ get: () => undefined }) }),
    },
  };
});
const tareas: Promise<unknown>[] = [];
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => tareas.push(p) }));

import { ContingenciaVentasService, MENSAJE_NO_PENDIENTE } from './contingencia-ventas.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Transcripción de contingencia desde ventas (Fase 9): el documento primero y
 * después, en orden, las notas de lo que pasó mientras la venta no lo tenía
 * (hallazgo (d) de la 6B). Falla cerrado y es idempotente.
 */
describe('ContingenciaVentasService', () => {
  const sedeId = new Types.ObjectId();
  const user = { email: 'a@x.co', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;
  let orden: string[];
  let sale: any;
  let registros: any[];
  let saleModel: any;
  let returnModel: any;
  let notas: { emitir: ReturnType<typeof vi.fn> };
  let puerto: any;
  let svc: ContingenciaVentasService;

  beforeEach(() => {
    orden = [];
    tareas.length = 0;
    sale = {
      _id: new Types.ObjectId(),
      sedeId,
      saleNumber: 'FV-000042',
      status: 'void',
      documentoFiscal: { solicitado: 'pos_anonimo', estado: 'pendiente_contingencia_07' },
    };
    registros = [
      { _id: new Types.ObjectId(), kind: 'devolucion', createdAt: 1, notaFiscal: { estado: 'sin_nota' } },
      { _id: new Types.ObjectId(), kind: 'rebaja', createdAt: 2 },
    ];
    saleModel = {
      findById: vi.fn(() => ({ exec: async () => sale })),
      updateOne: vi.fn((f: any, u: any) => ({
        exec: async () => {
          orden.push(`venta:${Object.keys(u.$set).join(',')}`);
          return { matchedCount: 1, filtro: f };
        },
      })),
    };
    returnModel = {
      find: vi.fn(() => {
        const c: any = { sort: () => c, exec: async () => registros };
        return c;
      }),
      updateOne: vi.fn(() => ({ exec: async () => ({}) })),
    };
    notas = {
      emitir: vi.fn(async (_s: any, sol: any) => {
        orden.push(`nota:${sol.origen}`);
        return { estado: 'emitida', documentoId: `n-${sol.origen}`, fullNumber: 'NAC1' };
      }),
    };
    puerto = {
      transcribirContingencia: vi.fn(async () => {
        orden.push('documento');
        return { documentoId: 'd1', tipo: 'pos', fullNumber: 'CONT1', cude: 'c', dianStatus: 'draft' };
      }),
      transmitirContingencia: vi.fn(async () => {
        orden.push('transmitir');
      }),
    };
    const devoluciones = { solicitudNota: (r: any) => ({ origen: `${r.kind}:${String(r._id)}`, concepto: '1', motivo: 'x' }) };
    svc = new ContingenciaVentasService(
      { get: () => puerto } as never,
      saleModel,
      returnModel,
      notas as never,
      devoluciones as never,
    );
  });

  it('documento, la venta queda emitida, notas en orden (devolución, rebaja, anulación) y después la transmisión', async () => {
    const r = await svc.transcribir(String(sale._id), user);
    await Promise.all(tareas);
    expect(orden).toEqual([
      'documento',
      'venta:documentoFiscal',
      `nota:devolucion:${String(registros[0]._id)}`,
      `nota:rebaja:${String(registros[1]._id)}`,
      `nota:anulacion:${String(sale._id)}`,
      'venta:notaAnulacion',
      'transmitir',
    ]);
    expect(r.pendientes).toBe(0);
    expect(r.notas.map((n) => n.operacion)).toEqual(['devolucion', 'rebaja', 'anulacion']);
    expect(returnModel.updateOne).toHaveBeenCalledTimes(2);
  });

  it('una nota que falla detiene las siguientes (orden) y se informa; el documento queda', async () => {
    notas.emitir.mockImplementationOnce(async () => {
      throw new ConflictException('tope excedido');
    });
    const r = await svc.transcribir(String(sale._id), user);
    expect(r.notas).toEqual([{ operacion: 'devolucion', id: String(registros[0]._id), error: 'tope excedido' }]);
    expect(r.pendientes).toBe(1);
    expect(notas.emitir).toHaveBeenCalledTimes(1);
  });

  it('el documento no se puede transcribir: lanza y no toca la venta ni emite notas', async () => {
    puerto.transcribirContingencia.mockRejectedValue(new BadRequestException('sin numeración'));
    await expect(svc.transcribir(String(sale._id), user)).rejects.toThrow('sin numeración');
    expect(saleModel.updateOne).not.toHaveBeenCalled();
    expect(notas.emitir).not.toHaveBeenCalled();
  });

  it('una venta sin documento pendiente no se transcribe; una sin acceso a la sede, 403', async () => {
    sale.documentoFiscal = undefined;
    await expect(svc.transcribir(String(sale._id), user)).rejects.toThrow(MENSAJE_NO_PENDIENTE);
    sale.documentoFiscal = { solicitado: 'pos_anonimo', estado: 'error' };
    await expect(svc.transcribir(String(sale._id), user)).rejects.toThrow(MENSAJE_NO_PENDIENTE);
    sale.documentoFiscal = { solicitado: 'pos_anonimo', estado: 'pendiente_contingencia_07' };
    const cajero = { ...user, role: 'cashier', sedeIds: [String(new Types.ObjectId())] } as unknown as JwtUser;
    await expect(svc.transcribir(String(sale._id), cajero)).rejects.toThrow();
    expect(puerto.transcribirContingencia).not.toHaveBeenCalled();
  });

  it('reintento sobre una venta ya transcrita: sigue con las notas que faltan (anulación ya emitida no se repite)', async () => {
    sale.documentoFiscal = { solicitado: 'pos_anonimo', estado: 'emitido', documentoId: 'd1' };
    sale.notaAnulacion = { estado: 'emitida' };
    registros = [];
    const r = await svc.transcribir(String(sale._id), user);
    expect(r.notas).toEqual([]);
    expect(puerto.transcribirContingencia).toHaveBeenCalledTimes(1);
  });
  describe('conNotasPendientes', () => {
    const venta = (o: any = {}) => ({
      _id: new Types.ObjectId(),
      status: 'completed',
      documentoFiscal: { solicitado: 'pos_anonimo', estado: 'emitido', documentoId: 'd1' },
      ...o,
    });
    /** Devoluciones sin nota que devuelve el modelo, por venta. */
    const conRegistros = (ids: unknown[]) => {
      returnModel.find = vi.fn(() => {
        const c: any = { select: () => c, lean: () => c, exec: async () => ids.map((saleId) => ({ saleId })) };
        return c;
      });
    };

    it('suma devoluciones sin nota, anulación sin nota y notas sin aceptar en una venta emitida de contingencia', async () => {
      const v = venta({ status: 'void' });
      conRegistros([v._id, v._id]);
      puerto.notasPorTransmitir = vi.fn(async () => ({ d1: 3 }));
      const [r] = await svc.conNotasPendientes([v]);
      expect((r as any).documentoFiscal.notasPendientes).toBe(2 + 1 + 3);
      expect(returnModel.find).toHaveBeenCalledWith({ saleId: { $in: [v._id] }, 'notaFiscal.estado': { $ne: 'emitida' } });
    });

    it('con todo emitido y aceptado da 0 (no ofrece Transcribir)', async () => {
      const v = venta({ status: 'void', notaAnulacion: { estado: 'emitida' } });
      conRegistros([]);
      puerto.notasPorTransmitir = vi.fn(async () => ({ d1: 0 }));
      const [r] = await svc.conNotasPendientes([v]);
      expect((r as any).documentoFiscal.notasPendientes).toBe(0);
    });

    it('un documento normal (no de contingencia) da 0 y no consulta devoluciones', async () => {
      const find = returnModel.find;
      puerto.notasPorTransmitir = vi.fn(async () => ({}));
      const [r] = await svc.conNotasPendientes([venta()]);
      expect((r as any).documentoFiscal.notasPendientes).toBe(0);
      expect(returnModel.find).toBe(find);
      expect(returnModel.find).not.toHaveBeenCalled();
    });

    it('una venta pendiente de transcribir o sin documento fiscal no consulta nada', async () => {
      puerto.notasPorTransmitir = vi.fn();
      const pendiente = venta({ documentoFiscal: { solicitado: 'pos_anonimo', estado: 'pendiente_contingencia_07' } });
      const sinFiscal = { _id: new Types.ObjectId(), status: 'completed' };
      const [a, b] = await svc.conNotasPendientes([pendiente, sinFiscal]);
      expect((a as any).documentoFiscal.notasPendientes).toBe(0);
      expect(b).toBe(sinFiscal);
      expect(puerto.notasPorTransmitir).not.toHaveBeenCalled();
    });

    it('sin el método en el puerto no puede saber cuáles son de contingencia: 0', async () => {
      const [r] = await svc.conNotasPendientes([venta()]);
      expect((r as any).documentoFiscal.notasPendientes).toBe(0);
    });
  });
});
