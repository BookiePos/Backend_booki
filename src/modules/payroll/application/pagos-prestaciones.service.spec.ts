import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { PagosPrestacionesService } from './pagos-prestaciones.service';

/** Registro del pago de prima, cesantías e intereses (decisión 2 del dueño, Fase 8). */
const SEDE = new Types.ObjectId();
const EMP = new Types.ObjectId().toString();
const owner = { role: 'owner', permissions: [], sedeIds: [], email: 'o@x.co' } as any;
const otraSede = { role: 'cashier', permissions: [], sedeIds: [new Types.ObjectId().toString()], email: 'c@x.co' } as any;
const deLaSede = { role: 'cashier', permissions: [], sedeIds: [SEDE.toString()], email: 's@x.co' } as any;

const DTO = {
  employeeId: EMP,
  tipo: 'prima',
  monto: 750_000,
  periodoDesde: '2026-01-01',
  periodoHasta: '2026-06-30',
  medioPago: '47',
  fechaPago: '2026-06-15',
};

interface Opciones {
  empleado?: any;
  liquidacion?: any;
  nominaAceptada?: boolean;
  asientoFalla?: boolean;
  /** El índice único rechaza el create (otro envío ganó la carrera) y deja este pago. */
  carrera?: any;
}

function armar(o: Opciones = {}, inicial: any[] = []) {
  // Almacén en memoria con lo mínimo de Mongo que usa el servicio.
  const filas: any[] = inicial.map((f) => ({ ...f }));
  const cumple = (f: any, d: any) =>
    Object.entries(f).every(([k, v]: [string, any]) => {
      const val = d[k];
      if (v && typeof v === 'object' && !(v instanceof Types.ObjectId)) {
        if ('$lte' in v && !(val <= v.$lte)) return false;
        if ('$gte' in v && !(val >= v.$gte)) return false;
        return true;
      }
      return String(val) === String(v);
    });
  const q = <T>(v: T) => ({ lean: () => ({ exec: async () => v }), exec: async () => v });
  const pagos = {
    findOne: vi.fn((f: any) => q(filas.find((d) => cumple(f, d)) ?? null)),
    findById: vi.fn((id: any) => q(filas.find((d) => String(d._id) === String(id)) ?? null)),
    create: vi.fn(async (d: any) => {
      if (o.carrera) {
        filas.push({ ...o.carrera });
        throw Object.assign(new Error('E11000'), { code: 11000 });
      }
      const doc = { _id: new Types.ObjectId(), ...d };
      filas.push(doc);
      return doc;
    }),
    findOneAndUpdate: vi.fn((f: any, u: any) => {
      const d = filas.find((x) => cumple(f, x));
      if (d) Object.assign(d, u.$set);
      return q(d ? { ...d } : null);
    }),
    find: vi.fn(() => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => filas }) }) }) })),
  };
  const emp = 'empleado' in o ? o.empleado : { firstName: 'Ana', lastName: 'Pérez', sedeId: SEDE, contractType: 'indefinido', salaryType: 'ordinario', hireDate: '2024-02-01' };
  const employees = {
    findById: vi.fn(() => ({ select: () => ({ exec: async () => emp }) })),
    find: vi.fn(() => ({ select: () => ({ exec: async () => [{ _id: EMP }] }) })),
  };
  const liquidaciones = { findOne: vi.fn(() => ({ select: () => ({ lean: () => ({ exec: async () => o.liquidacion ?? null }) }) })) };
  const nomina = { findOne: vi.fn(() => ({ select: () => ({ lean: () => ({ exec: async () => (o.nominaAceptada ? { _id: 'd' } : null) }) }) })) };
  const ledger = {
    postPagoPrestacion: vi.fn(async (_i: any) => !o.asientoFalla),
    reversePagoPrestacion: vi.fn(async () => undefined),
  };
  const service = new PagosPrestacionesService(pagos as any, employees as any, liquidaciones as any, nomina as any, ledger as any);
  return { service, filas, pagos, ledger, employees };
}

describe('PagosPrestacionesService.registrar', () => {
  it('guarda el pago con la sede, los días del tramo y quién lo registró, y lo asienta en la fecha del pago', async () => {
    const t = armar();
    const r = await t.service.registrar(DTO as any, owner);
    expect(r).toMatchObject({
      employeeId: EMP,
      employeeName: 'Ana Pérez',
      sedeId: SEDE,
      tipo: 'prima',
      monto: 750_000,
      retencionFuente: 0,
      dias: 180,
      pago: { medio: '47', fecha: '2026-06-15' },
      estado: 'registrado',
      registradoPor: 'o@x.co',
    });
    expect(r.destino).toBeUndefined();
    expect(t.ledger.postPagoPrestacion).toHaveBeenCalledWith(
      expect.objectContaining({
        pagoId: String(r._id),
        date: '2026-06-15',
        sedeId: SEDE.toString(),
        partes: { monto: 750_000, retencionFuente: 0, medio: '47' },
      }),
    );
  });

  it('las cesantías van al fondo por defecto', async () => {
    const t = armar();
    const r = await t.service.registrar(
      { ...DTO, tipo: 'cesantias', monto: 1_500_000, periodoDesde: '2025-01-01', periodoHasta: '2025-12-31', medioPago: '42', fechaPago: '2026-02-10', fondo: ' Porvenir ' } as any,
      owner,
    );
    expect(r).toMatchObject({ destino: 'fondo', fondo: 'Porvenir', dias: 360 });
  });

  it('idempotente: reenviar el mismo pago devuelve el que ya existe, no crea otro y repara el asiento', async () => {
    const t = armar();
    const a = await t.service.registrar(DTO as any, owner);
    const b = await t.service.registrar(DTO as any, owner);
    expect(String(b._id)).toBe(String(a._id));
    expect(t.pagos.create).toHaveBeenCalledTimes(1);
    expect(t.filas).toHaveLength(1);
    expect(b.advertencias.join()).toMatch(/ya estaba registrado/);
    expect(t.ledger.postPagoPrestacion).toHaveBeenCalledTimes(2);
    expect(t.ledger.postPagoPrestacion.mock.calls[1]![0].pagoId).toBe(String(a._id));
  });

  it('el mismo tramo con otro monto o fecha se rechaza (409): se anula y se registra de nuevo', async () => {
    const t = armar();
    await t.service.registrar(DTO as any, owner);
    await expect(t.service.registrar({ ...DTO, monto: 800_000 } as any, owner)).rejects.toBeInstanceOf(ConflictException);
    await expect(t.service.registrar({ ...DTO, fechaPago: '2026-06-16' } as any, owner)).rejects.toBeInstanceOf(ConflictException);
    expect(t.filas).toHaveLength(1);
    expect(t.ledger.postPagoPrestacion).toHaveBeenCalledTimes(1);
  });

  it('un tramo que se cruza con otro pago vivo de la misma prestación se rechaza', async () => {
    const t = armar();
    await t.service.registrar(DTO as any, owner);
    await expect(t.service.registrar({ ...DTO, periodoDesde: '2026-03-01' } as any, owner)).rejects.toThrow(/se pagaría dos veces/);
    // Otra prestación del mismo tramo sí entra.
    await t.service.registrar({ ...DTO, tipo: 'intereses_cesantias', monto: 50_000 } as any, owner);
    expect(t.filas).toHaveLength(2);
  });

  it('carrera: si el índice único rechaza el create, responde con el pago que ganó', async () => {
    const ganador = { _id: new Types.ObjectId(), ...DTO, retencionFuente: 0, pago: { medio: '47', fecha: '2026-06-15' }, estado: 'registrado' };
    const t = armar({ carrera: ganador });
    const r = await t.service.registrar(DTO as any, owner);
    expect(String(r._id)).toBe(String(ganador._id));
    expect(t.filas).toHaveLength(1);
  });

  it('valida el pago y a quién se le paga (400) antes de guardar', async () => {
    const t = armar();
    await expect(t.service.registrar({ ...DTO, periodoHasta: '2026-12-31' } as any, owner)).rejects.toThrow(/art\. 306 CST/);
    await expect(t.service.registrar({ ...DTO, fechaPago: '2999-01-01' } as any, owner)).rejects.toBeInstanceOf(BadRequestException);
    const integral = armar({ empleado: { sedeId: SEDE, salaryType: 'integral' } });
    await expect(integral.service.registrar(DTO as any, owner)).rejects.toThrow(/art\. 132 CST/);
    const contratista = armar({ empleado: { sedeId: SEDE, contractType: 'prestacion_servicios' } });
    await expect(contratista.service.registrar(DTO as any, owner)).rejects.toBeInstanceOf(BadRequestException);
    for (const x of [t, integral, contratista]) {
      expect(x.pagos.create).not.toHaveBeenCalled();
      expect(x.ledger.postPagoPrestacion).not.toHaveBeenCalled();
    }
  });

  it('no deja pagar lo que ya paga la liquidación de retiro aprobada', async () => {
    const t = armar({ liquidacion: { fechaRetiro: '2026-05-20' } });
    await expect(t.service.registrar(DTO as any, owner)).rejects.toThrow(/liquidación de retiro aprobada/);
    // Lo del semestre anterior al retiro sí.
    const r = await t.service.registrar({ ...DTO, periodoDesde: '2025-07-01', periodoHasta: '2025-12-31', fechaPago: '2025-12-15' } as any, owner);
    expect(r.estado).toBe('registrado');
  });

  it('sedes: el empleado de otra sede da 404; el de la propia se registra', async () => {
    await expect(armar().service.registrar(DTO as any, otraSede)).rejects.toBeInstanceOf(NotFoundException);
    expect((await armar().service.registrar(DTO as any, deLaSede)).estado).toBe('registrado');
    await expect(armar({ empleado: null }).service.registrar(DTO as any, owner)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('avisa si el asiento quedó pendiente y si la nómina electrónica del mes ya fue aceptada', async () => {
    const t = armar({ asientoFalla: true, nominaAceptada: true });
    const r = await t.service.registrar(DTO as any, owner);
    expect(r.estado).toBe('registrado');
    expect(r.advertencias.join(' | ')).toMatch(/pendiente de conciliación/);
    expect(r.advertencias.join(' | ')).toMatch(/2026-06.*ya fue aceptada.*Corregir/);
  });
});

describe('PagosPrestacionesService.anular', () => {
  it('anula una sola vez y pide el contra-asiento; repetir no falla ni cambia quién anuló', async () => {
    const t = armar();
    const p = await t.service.registrar(DTO as any, owner);
    const a = await t.service.anular(String(p._id), ' se digitó mal ', owner);
    expect(a).toMatchObject({ estado: 'anulado', anuladoPor: 'o@x.co', motivoAnulacion: 'se digitó mal' });
    expect(t.ledger.reversePagoPrestacion).toHaveBeenCalledWith(String(p._id), 'o@x.co');
    const b = await t.service.anular(String(p._id), 'otra vez', deLaSede);
    expect(b).toMatchObject({ estado: 'anulado', anuladoPor: 'o@x.co', motivoAnulacion: 'se digitó mal' });
    expect(b.advertencias.join()).toMatch(/ya estaba anulado/);
    // El segundo intento vuelve a pedir la reversa: `reverseBySource` no hace nada si ya está reversado.
    expect(t.ledger.reversePagoPrestacion).toHaveBeenCalledTimes(2);
  });

  it('tras anular se puede registrar de nuevo el mismo tramo', async () => {
    const t = armar();
    const p = await t.service.registrar(DTO as any, owner);
    await t.service.anular(String(p._id), undefined, owner);
    const nuevo = await t.service.registrar({ ...DTO, monto: 800_000 } as any, owner);
    expect(String(nuevo._id)).not.toBe(String(p._id));
    expect(nuevo.monto).toBe(800_000);
  });

  it('404 si no existe o si el empleado es de otra sede; avisa si la nómina electrónica ya fue aceptada', async () => {
    const t = armar({ nominaAceptada: true });
    await expect(t.service.anular(new Types.ObjectId().toString(), undefined, owner)).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.service.anular('xyz', undefined, owner)).rejects.toBeInstanceOf(NotFoundException);
    const p = await t.service.registrar(DTO as any, owner);
    await expect(t.service.anular(String(p._id), undefined, otraSede)).rejects.toBeInstanceOf(NotFoundException);
    expect(t.ledger.reversePagoPrestacion).not.toHaveBeenCalled();
    const a = await t.service.anular(String(p._id), undefined, owner);
    expect(a.advertencias.join()).toMatch(/ya fue aceptada/);
  });
});

describe('PagosPrestacionesService.listar', () => {
  it('filtra por año del pago y oculta los anulados salvo que se pidan; valida los filtros', async () => {
    const t = armar();
    await t.service.listar({ anio: '2026' }, owner);
    expect(t.pagos.find).toHaveBeenLastCalledWith({ 'pago.fecha': { $gte: '2026-01-01', $lte: '2026-12-31' }, estado: 'registrado' });
    await t.service.listar({ employeeId: EMP, incluirAnulados: true }, owner);
    expect(t.pagos.find).toHaveBeenLastCalledWith({ employeeId: EMP });
    await expect(t.service.listar({ anio: '26' }, owner)).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.service.listar({ employeeId: 'x' }, owner)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('quien está limitado a sedes solo ve los pagos de sus empleados', async () => {
    const t = armar();
    await t.service.listar({}, deLaSede);
    expect(t.pagos.find).toHaveBeenLastCalledWith({ estado: 'registrado', employeeId: { $in: [EMP] } });
    await t.service.listar({ employeeId: new Types.ObjectId().toString() }, deLaSede);
    expect(t.pagos.find).toHaveBeenLastCalledWith({ estado: 'registrado', employeeId: { $in: [] } });
  });
});
