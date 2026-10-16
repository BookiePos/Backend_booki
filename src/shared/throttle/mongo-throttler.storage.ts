import { Logger } from '@nestjs/common';
import {
  ThrottlerStorageService,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import {
  asegurarIndiceTtl,
  contarEnVentana,
  type ColeccionVentanas,
} from './contador-ventana';

/**
 * Hasta este límite, el contador vive en Mongo y es uno solo para todas las
 * instancias. Los límites estrictos son los de seguridad y costo: login,
 * registro, recuperación de contraseña, invitaciones y lectura con IA (de 5 a
 * 20 por ventana). El límite general de 100 por minuto sigue en memoria: es un
 * freno contra el abuso, no una cuenta exacta, y llevarlo a Mongo sumaría una
 * consulta a cada request del POS.
 */
export const LIMITE_DISTRIBUIDO = 20;

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Almacén del `ThrottlerGuard` repartido entre instancias (ítem 4.3).
 *
 * Ventana fija: al pasar el límite, se bloquea hasta que la ventana termina.
 * Los `@Throttle` del API no fijan `blockDuration`, que por defecto es el mismo
 * `ttl`, así que el bloqueo dura lo mismo o menos que con el almacén en memoria.
 *
 * Si Mongo falla, cae al almacén en memoria de la instancia: un límite por
 * instancia es peor que uno compartido, pero tumbar el login por no poder
 * contar sería peor.
 */
export class MongoThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('MongoThrottlerStorage');
  private readonly memoria = new ThrottlerStorageService();
  private readonly indices = new WeakMap<object, Promise<unknown>>();

  constructor(private readonly coleccion: () => ColeccionVentanas) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (limit > LIMITE_DISTRIBUIDO) {
      return this.memoria.increment(key, ttl, limit, blockDuration, throttlerName);
    }
    try {
      const col = this.coleccion();
      await asegurarIndiceTtl(col, this.indices);
      const ahora = Date.now();
      const doc = await contarEnVentana(col, `${throttlerName}:${key}`, ttl, ahora);
      const restante = Math.max(0, Math.ceil((doc.hasta.getTime() - ahora) / 1000));
      const bloqueado = doc.hits > limit;
      return {
        totalHits: doc.hits,
        timeToExpire: restante,
        isBlocked: bloqueado,
        timeToBlockExpire: bloqueado ? restante : 0,
      };
    } catch (err) {
      this.logger.warn(
        `Sin contador compartido, se limita por instancia: ${(err as Error).message}`,
      );
      return this.memoria.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}
