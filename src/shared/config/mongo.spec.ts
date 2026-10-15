import { describe, it, expect } from 'vitest';
import { POOL_MONGO, uriSinCredenciales } from './mongo';

describe('conexión a Mongo (ítem 2.11)', () => {
  it('pool acotado para funciones serverless: entre 5 y 10 conexiones', () => {
    expect(POOL_MONGO.maxPoolSize).toBeGreaterThanOrEqual(5);
    expect(POOL_MONGO.maxPoolSize).toBeLessThanOrEqual(10);
    expect(POOL_MONGO.minPoolSize).toBe(0);
    // Las conexiones ociosas se cierran: la función se congela entre requests.
    expect(POOL_MONGO.maxIdleTimeMS).toBeGreaterThan(0);
  });

  it('el log nunca muestra usuario ni contraseña de la URI', () => {
    expect(
      uriSinCredenciales(
        'mongodb+srv://dueno:S3cr3t%40@cluster0.abcd.mongodb.net/sistema-pos?retryWrites=true',  // secretos-ok: credencial inventada; la prueba verifica que se oculte
      ),
    ).toBe('mongodb+srv://***@cluster0.abcd.mongodb.net/sistema-pos');
    expect(uriSinCredenciales('mongodb://localhost:27017/sistema-pos?replicaSet=rs0')).toBe(
      'mongodb://localhost:27017/sistema-pos',
    );
  });
});
