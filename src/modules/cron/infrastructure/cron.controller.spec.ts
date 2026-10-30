import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

// Mismo patrón que el resto de specs: los decoradores de @nestjs/mongoose
// revientan al importar esquemas (los schedulers arrastran servicios).
vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return { ...actual, Prop: () => () => undefined, Schema: () => () => undefined };
});

import { CronController } from './cron.controller';
import { secretoDeCronValido } from '../domain/cron-auth';

describe('secretoDeCronValido', () => {
  it('acepta solo «Bearer <secreto>» exacto', () => {
    expect(secretoDeCronValido('Bearer s3cr3t', 's3cr3t')).toBe(true);
    expect(secretoDeCronValido('Bearer otro', 's3cr3t')).toBe(false);
    expect(secretoDeCronValido('s3cr3t', 's3cr3t')).toBe(false);
    expect(secretoDeCronValido(undefined, 's3cr3t')).toBe(false);
  });

  it('sin secreto configurado nada pasa, ni siquiera un «Bearer » vacío', () => {
    expect(secretoDeCronValido('Bearer ', '')).toBe(false);
    expect(secretoDeCronValido('Bearer undefined', undefined)).toBe(false);
  });
});

describe('CronController.diario', () => {
  const ok = { estado: 'ok' };
  const billing = { sweep: vi.fn() };
  const recurrentes = { sweep: vi.fn() };
  const certificados = { barrerVencimientos: vi.fn() };
  const conSecreto = (secreto?: string) =>
    new CronController(
      { get: () => secreto } as never,
      billing as never,
      recurrentes as never,
      certificados as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    billing.sweep.mockResolvedValue(ok);
    recurrentes.sweep.mockResolvedValue(ok);
    certificados.barrerVencimientos.mockResolvedValue(ok);
  });

  it('con el secreto correcto corre los dos barridos', async () => {
    const r = await conSecreto('s3cr3t').diario('Bearer s3cr3t');
    expect(r.ok).toBe(true);
    expect(billing.sweep).toHaveBeenCalledTimes(1);
    expect(recurrentes.sweep).toHaveBeenCalledTimes(1);
    expect(certificados.barrerVencimientos).toHaveBeenCalledTimes(1);
    expect(r.tareas['certificados-fe']).toEqual(ok);
  });

  it('sin el secreto correcto responde 401 y no corre nada', async () => {
    await expect(conSecreto('s3cr3t').diario('Bearer adivinado')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(conSecreto('s3cr3t').diario(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(billing.sweep).not.toHaveBeenCalled();
    expect(recurrentes.sweep).not.toHaveBeenCalled();
  });

  it('sin CRON_SECRET en el despliegue queda cerrado (503), no abierto', async () => {
    await expect(conSecreto(undefined).diario('Bearer cualquiera')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(billing.sweep).not.toHaveBeenCalled();
  });

  it('el 503 no le cuenta a quien llama qué falta en el despliegue', async () => {
    const err = await conSecreto(undefined)
      .diario(undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((err as ServiceUnavailableException).getResponse())).not.toMatch(
      /CRON_SECRET/,
    );
  });

  it('si un barrido falla responde 500 (rojo en Vercel) y aun así corre el otro', async () => {
    billing.sweep.mockResolvedValue({ estado: 'error', detalle: 'pasarela caída' });

    const err = await conSecreto('s3cr3t')
      .diario('Bearer s3cr3t')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(recurrentes.sweep).toHaveBeenCalledTimes(1);
    expect((err as InternalServerErrorException).getResponse()).toMatchObject({
      ok: false,
      tareas: { cobros: { estado: 'error', detalle: 'pasarela caída' } },
    });
  });

  it('un barrido omitido (otro en marcha) no es un fallo', async () => {
    recurrentes.sweep.mockResolvedValue({ estado: 'omitido' });

    const r = await conSecreto('s3cr3t').diario('Bearer s3cr3t');

    expect(r.ok).toBe(true);
    expect(r.tareas['gastos-recurrentes']).toEqual({ estado: 'omitido' });
  });
});
