import { describe, it, expect } from 'vitest';
import { MongoThrottlerStorage } from './mongo-throttler.storage';
import { contarEnVentana } from './contador-ventana';
import { coleccionFalsa } from './coleccion-falsa';

/**
 * Ítem 4.3: en Vercel cada instancia tenía su propio contador, así que el
 * límite de 5 intentos de login era de 5 POR INSTANCIA. Con el contador en la
 * base de control, dos instancias suman en el mismo.
 */
describe('MongoThrottlerStorage', () => {
  it('dos instancias comparten el contador y la sexta petición se bloquea', async () => {
    const col = coleccionFalsa();
    const a = new MongoThrottlerStorage(() => col);
    const b = new MongoThrottlerStorage(() => col);

    for (let i = 0; i < 5; i++) {
      const r = await (i % 2 ? a : b).increment('login:ip', 300_000, 5, 300_000, 'default');
      expect(r.isBlocked).toBe(false);
    }
    const sexta = await a.increment('login:ip', 300_000, 5, 300_000, 'default');
    expect(sexta.totalHits).toBe(6);
    expect(sexta.isBlocked).toBe(true);
    expect(sexta.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('el límite general (más de 20) se queda en memoria y no toca la base', async () => {
    const col = coleccionFalsa();
    const s = new MongoThrottlerStorage(() => col);
    await s.increment('ip', 60_000, 100, 60_000, 'default');
    expect(col.docs.size).toBe(0);
  });

  it('si Mongo falla, cuenta en memoria en vez de tumbar la petición', async () => {
    const col = coleccionFalsa();
    col.falla = new Error('sin conexión');
    const s = new MongoThrottlerStorage(() => col);
    const r = await s.increment('login:ip', 300_000, 5, 300_000, 'default');
    expect(r.totalHits).toBe(1);
    expect(r.isBlocked).toBe(false);
  });
});

describe('contarEnVentana', () => {
  it('abre la ventana, suma en ella y vuelve a 1 cuando vence', async () => {
    const col = coleccionFalsa();
    const t0 = 1_000_000;
    expect((await contarEnVentana(col, 'k', 1000, t0)).hits).toBe(1);
    expect((await contarEnVentana(col, 'k', 1000, t0 + 500)).hits).toBe(2);
    const nueva = await contarEnVentana(col, 'k', 1000, t0 + 1000);
    expect(nueva.hits).toBe(1);
    expect(nueva.hasta.getTime()).toBe(t0 + 2000);
  });

  it('si otra instancia abrió la ventana entre los dos pasos, suma en la suya', async () => {
    const col = coleccionFalsa();
    const t0 = 1_000_000;
    const original = col.findOneAndUpdate.bind(col);
    let primera = true;
    col.findOneAndUpdate = async (filter, update, options) => {
      // Simula la carrera: justo antes del upsert, otra instancia abre la ventana.
      if (options.upsert && primera) {
        primera = false;
        col.docs.set('k', { _id: 'k', hits: 1, hasta: new Date(t0 + 1000) });
      }
      return original(filter, update, options);
    };
    const doc = await contarEnVentana(col, 'k', 1000, t0);
    expect(doc.hits).toBe(2);
  });
});
