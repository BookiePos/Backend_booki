import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { CONTROL_CONNECTION } from '../../control/domain/control.constants';
import {
  asegurarIndiceTtl,
  contarEnVentana,
  type ColeccionVentanas,
  type DocVentana,
} from '../../../shared/throttle/contador-ventana';

/** Fallos seguidos que bloquean la cuenta. */
export const FALLOS_PARA_BLOQUEO = 5;
/** Ventana en la que se cuentan, y que dura el bloqueo. */
export const VENTANA_FALLOS_MS = 15 * 60_000;

export interface ColeccionIntentos extends ColeccionVentanas {
  findOne(filter: Record<string, unknown>): Promise<DocVentana | null>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
}

/**
 * Bloqueo temporal por cuenta tras varios fallos de login (ítem 4.3).
 *
 * El throttle por IP no frena a quien prueba contraseñas desde muchas IP
 * contra la misma cuenta. Aquí se cuenta por identificador (correo o usuario),
 * exista o no: si solo se contaran las cuentas que existen, el bloqueo diría
 * cuáles existen. Cinco fallos en 15 minutos bloquean hasta que la ventana
 * termina; un login correcto la borra.
 *
 * El precio conocido: cualquiera puede bloquear una cuenta ajena 15 minutos
 * fallando a propósito. Por eso el bloqueo es corto y la recuperación de
 * contraseña sigue abierta.
 *
 * Fallar al contar no impide entrar: el login ya está detrás del throttle por
 * IP, y dejar a todos fuera por un fallo de la base sería peor.
 */
@Injectable()
export class IntentosLoginService {
  private readonly logger = new Logger('IntentosLogin');
  private readonly indices = new WeakMap<object, Promise<unknown>>();

  constructor(
    @InjectConnection(CONTROL_CONNECTION)
    private readonly control: Connection,
  ) {}

  /** 429 si la cuenta está bloqueada. */
  async assertNoBloqueada(identificador: string): Promise<void> {
    let doc: DocVentana | null = null;
    try {
      doc = await this.coleccion().findOne({
        _id: llave(identificador),
        hasta: { $gt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`No se pudo leer el bloqueo: ${(err as Error).message}`);
      return;
    }
    if (doc && doc.hits >= FALLOS_PARA_BLOQUEO) {
      const minutos = Math.max(1, Math.ceil((doc.hasta.getTime() - Date.now()) / 60_000));
      throw new HttpException(
        `Demasiados intentos fallidos. Espera ${minutos} min o recupera tu contraseña.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async registrarFallo(identificador: string): Promise<void> {
    try {
      const col = this.coleccion();
      await asegurarIndiceTtl(col, this.indices);
      await contarEnVentana(col, llave(identificador), VENTANA_FALLOS_MS);
    } catch (err) {
      this.logger.warn(`No se pudo contar el fallo: ${(err as Error).message}`);
    }
  }

  async limpiar(identificador: string): Promise<void> {
    try {
      await this.coleccion().deleteOne({ _id: llave(identificador) });
    } catch (err) {
      this.logger.warn(`No se pudo limpiar el contador: ${(err as Error).message}`);
    }
  }

  private coleccion(): ColeccionIntentos {
    return this.control.collection('login_fallos') as unknown as ColeccionIntentos;
  }
}

const llave = (identificador: string): string =>
  `login:${identificador.trim().toLowerCase()}`;
