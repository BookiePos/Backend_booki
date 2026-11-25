import { describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    InjectModel: () => () => undefined,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: { createForClass: () => ({ index: () => undefined, pre: () => undefined }) },
  };
});

import { BadRequestException } from '@nestjs/common';
import { QuincenaService, type PropuestaQuincena } from './quincena.service';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/** Consulta encadenable de Mongoose que termina en `exec()`. */
const consulta = <T>(valor: T) => {
  const q = { select: () => q, sort: () => q, limit: () => q, exec: async () => valor };
  return q;
};

const dueno = { email: 'dueno@x.co', role: 'owner', permissions: [], sedeIds: [] } as unknown as JwtUser;

function linea(id: string, neto: number): PropuestaQuincena {
  return {
    employeeId: id,
    employeeName: `Trabajador ${id}`,
    dias: 15,
    sueldo: neto,
    auxilioTransporte: 0,
    recargos: 0,
    horasExtra: 0,
    horas: {},
    salud: 0,
    pension: 0,
    fsp: 0,
    neto,
    tope: neto,
    avisos: [],
  };
}

function armar(opts: {
  lineas?: PropuestaQuincena[];
  nominasDelMes?: { coverage: string; sedeId?: string }[];
  crear?: () => Promise<unknown>;
  cerradaAlFinal?: boolean;
} = {}) {
  const creada = { _id: 'q1', toString: () => 'q1' };
  const quincenas = {
    create: vi.fn(opts.crear ?? (async () => creada)),
    deleteOne: vi.fn(() => consulta({ deletedCount: 1 })),
  };
  const runs = {
    find: vi.fn(() => consulta(opts.nominasDelMes ?? [])),
    exists: vi.fn(() => consulta(opts.cerradaAlFinal ? { _id: 'r1' } : null)),
  };
  const ledger = { postPagoSalarios: vi.fn(async () => true) };
  const payroll = { recalcularBorradoresDelPeriodo: vi.fn(async () => []) };
  const svc = new QuincenaService(
    quincenas as never,
    runs as never,
    {} as never,
    {} as never,
    {} as never,
    payroll as never,
    ledger as never,
  );
  vi.spyOn(svc, 'propuesta').mockResolvedValue({
    period: '2026-11',
    corte: '2026-11-15',
    lineas: opts.lineas ?? [linea('a', 800_000), linea('b', 600_000)],
    yaPagados: [],
    cerrada: false,
  });
  return { svc, quincenas, runs, ledger };
}

const dto = (lineas: { employeeId: string; neto?: number }[], extra: Record<string, unknown> = {}) =>
  ({ period: '2026-11', coverage: 'all', medioPago: '10', fechaPago: '2026-11-15', lineas, ...extra }) as never;

describe('QuincenaService.registrar', () => {
  it('asienta un solo pago por el total de las líneas, recalculado en el servidor', async () => {
    const { svc, ledger } = armar();
    await svc.registrar(dto([{ employeeId: 'a' }, { employeeId: 'b', neto: 500_000 }]), dueno);
    expect(ledger.postPagoSalarios).toHaveBeenCalledTimes(1);
    expect(ledger.postPagoSalarios).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'pago_quincena', monto: 1_300_000, sedeId: undefined }),
    );
  });

  it('no acepta pagarle a alguien más de lo calculado', async () => {
    const { svc, ledger } = armar();
    await expect(svc.registrar(dto([{ employeeId: 'a', neto: 800_001 }]), dueno)).rejects.toThrow(/hasta/);
    expect(ledger.postPagoSalarios).not.toHaveBeenCalled();
  });

  it('un doble clic no paga dos veces: el índice único corta el segundo y no se asienta nada', async () => {
    const { svc, ledger } = armar({
      crear: async () => {
        throw Object.assign(new Error('E11000 quincena_viva_unica'), {
          code: 11000,
          keyPattern: { period: 1, 'lineas.employeeId': 1 },
        });
      },
    });
    await expect(svc.registrar(dto([{ employeeId: 'a' }]), dueno)).rejects.toThrow(/ya se le pagó/);
    expect(ledger.postPagoSalarios).not.toHaveBeenCalled();
  });

  it('si el mes se cerró mientras se registraba, deshace el pago y no lo asienta', async () => {
    const { svc, ledger, quincenas } = armar({ cerradaAlFinal: true });
    await expect(svc.registrar(dto([{ employeeId: 'a' }]), dueno)).rejects.toThrow(/se cerró/);
    expect(quincenas.deleteOne).toHaveBeenCalled();
    expect(ledger.postPagoSalarios).not.toHaveBeenCalled();
  });

  it('exige la misma cobertura que la nómina del mes ya calculada (si no, la 2505 queda con saldo por sede)', async () => {
    const { svc, ledger } = armar({ nominasDelMes: [{ coverage: 'sede', sedeId: '64b000000000000000000001' }] });
    await expect(svc.registrar(dto([{ employeeId: 'a' }]), dueno)).rejects.toBeInstanceOf(BadRequestException);
    expect(ledger.postPagoSalarios).not.toHaveBeenCalled();
  });
});
