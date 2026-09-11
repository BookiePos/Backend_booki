import { describe, it, expect } from 'vitest';

import { HealthController } from './health.controller';

/**
 * Sonda de salud.
 *
 * La usa el proveedor de hosting para decidir si el contenedor sigue vivo y si
 * manda tráfico a un despliegue nuevo. Tiene que responder SIEMPRE, incluso con
 * la base caída: si devolviera error por eso, el orquestador reiniciaría el
 * servicio en bucle y la caída de Mongo se convertiría en una caída total.
 *
 * Por eso el estado del servidor y el de la base son dos campos distintos: la
 * API está bien aunque la base no lo esté, y quien mira la sonda necesita
 * distinguirlo.
 */
describe('HealthController', () => {
  /** @param readyState estado de la conexión de Mongoose */
  function build(readyState: number) {
    return new HealthController({ readyState } as never);
  }

  it('reporta la base conectada', () => {
    const r = build(1).check();

    expect(r.status).toBe('ok');
    expect(r.db).toBe('connected');
  });

  it('con la base caída sigue respondiendo ok, pero lo dice', () => {
    const r = build(0).check();

    expect(r.status).toBe('ok');
    expect(r.db).toBe('disconnected');
  });

  it('distingue los estados intermedios', () => {
    expect(build(2).check().db).toBe('connecting');
    expect(build(3).check().db).toBe('disconnecting');
  });

  it('un estado que no conoce no se reporta como conectado', () => {
    // Ante un valor inesperado, lo honesto es admitir que no se sabe. Darlo por
    // conectado mandaría tráfico a una instancia que quizá no puede atenderlo.
    const r = build(99).check();

    expect(r.db).toBe('unknown');
  });

  it('devuelve la hora en formato ISO, para fechar la respuesta', () => {
    const r = build(1).check();

    expect(new Date(r.time).toISOString()).toBe(r.time);
  });
});
