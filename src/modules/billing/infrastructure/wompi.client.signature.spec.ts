import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { WompiClient } from './wompi.client';

/**
 * Firma e integridad con la pasarela de pagos.
 *
 * Son las dos piezas criptográficas del cobro, y las dos fallan en silencio:
 *
 * - La firma de INTEGRIDAD viaja al crear la transacción. Si se calculara mal,
 *   la pasarela rechaza todos los cobros y las renovaciones dejan de entrar.
 * - El checksum del EVENTO es lo único que separa un webhook legítimo de uno
 *   inventado. Quien pueda falsificarlo se activa el plan sin pagar, porque el
 *   webhook es una ruta pública por necesidad.
 *
 * El cliente se instancia con un `ConfigService` de mentira; ninguna prueba sale
 * a la red.
 */
describe('WompiClient · firma e integridad', () => {
  const LLAVES = {
    WOMPI_ENV: 'sandbox',
    WOMPI_PUBLIC_KEY: 'pub_test_123',
    WOMPI_PRIVATE_KEY: 'prv_test_123',
    WOMPI_INTEGRITY_SECRET: 'integridad_secreta',
    WOMPI_EVENTS_SECRET: 'eventos_secreto',
  } as Record<string, string>;

  /** Cliente con las variables de entorno indicadas. */
  function client(over: Record<string, string | undefined> = {}) {
    const env = { ...LLAVES, ...over };
    return new WompiClient({
      get: (k: string) => env[k],
    } as never);
  }

  describe('configuración', () => {
    it('con las cuatro llaves está configurado', () => {
      expect(client().configured).toBe(true);
    });

    it('si falta cualquiera de las llaves, NO está configurado', () => {
      for (const falta of [
        'WOMPI_PUBLIC_KEY',
        'WOMPI_PRIVATE_KEY',
        'WOMPI_INTEGRITY_SECRET',
        'WOMPI_EVENTS_SECRET',
      ]) {
        expect(client({ [falta]: undefined }).configured).toBe(false);
      }
    });

    it('por defecto apunta al sandbox, no a producción', () => {
      expect(client({ WOMPI_ENV: undefined }).environment).toBe('sandbox');
      expect(client({ WOMPI_ENV: 'cualquier-cosa' }).environment).toBe(
        'sandbox',
      );
    });

    it('solo el valor exacto activa producción', () => {
      expect(client({ WOMPI_ENV: 'production' }).environment).toBe('production');
    });
  });

  describe('firma de integridad', () => {
    it('es el hash de referencia, monto, moneda y secreto, en ese orden', () => {
      const esperado = createHash('sha256')
        .update('ref-1' + '9900000' + 'COP' + 'integridad_secreta')
        .digest('hex');

      expect(client().integritySignature('ref-1', 9_900_000)).toBe(esperado);
    });

    it('el mismo cobro firma siempre igual', () => {
      const c = client();

      expect(c.integritySignature('ref-1', 100)).toBe(
        c.integritySignature('ref-1', 100),
      );
    });

    it('cambiar el monto cambia la firma', () => {
      const c = client();

      expect(c.integritySignature('ref-1', 100)).not.toBe(
        c.integritySignature('ref-1', 101),
      );
    });

    it('cambiar la referencia cambia la firma', () => {
      const c = client();

      expect(c.integritySignature('ref-1', 100)).not.toBe(
        c.integritySignature('ref-2', 100),
      );
    });

    it('con otro secreto sale otra firma: el secreto entra de verdad', () => {
      const a = client().integritySignature('ref-1', 100);
      const b = client({
        WOMPI_INTEGRITY_SECRET: 'otro',
      }).integritySignature('ref-1', 100);

      expect(a).not.toBe(b);
    });
  });

  describe('checksum del evento', () => {
    /** Arma un evento firmado como lo haría la pasarela. */
    function evento(over: {
      status?: string;
      amount?: number;
      timestamp?: number;
      secreto?: string;
      properties?: string[];
    } = {}) {
      const status = over.status ?? 'APPROVED';
      const amount = over.amount ?? 9_900_000;
      const timestamp = over.timestamp ?? 1_757_000_000;
      const properties = over.properties ?? [
        'transaction.id',
        'transaction.status',
        'transaction.amount_in_cents',
      ];
      const data = {
        transaction: {
          id: 'tx-1',
          reference: 'ref-1',
          status,
          amount_in_cents: amount,
        },
      };
      // La pasarela concatena SOLO los campos que declara en `properties`.
      const valor: Record<string, string> = {
        'transaction.id': 'tx-1',
        'transaction.status': status,
        'transaction.amount_in_cents': String(amount),
      };
      const concat = properties.map((p) => valor[p] ?? '').join('');
      const checksum = createHash('sha256')
        .update(`${concat}${timestamp}${over.secreto ?? 'eventos_secreto'}`)
        .digest('hex');
      return {
        event: 'transaction.updated',
        data,
        timestamp,
        signature: { checksum, properties },
      };
    }

    it('acepta un evento firmado con el secreto correcto', () => {
      expect(client().verifyEvent(evento())).toBe(true);
    });

    it('acepta el checksum en mayúsculas', () => {
      const e = evento();
      e.signature.checksum = e.signature.checksum.toUpperCase();

      expect(client().verifyEvent(e)).toBe(true);
    });

    it('rechaza un evento firmado con otro secreto', () => {
      expect(client().verifyEvent(evento({ secreto: 'robado' }))).toBe(false);
    });

    it('rechaza si alguien cambia el estado después de firmar', () => {
      // El ataque evidente: tomar un evento real de rechazo y volverlo aprobado.
      const e = evento({ status: 'DECLINED' });
      e.data.transaction.status = 'APPROVED';

      expect(client().verifyEvent(e)).toBe(false);
    });

    it('rechaza si alguien cambia el monto después de firmar', () => {
      const e = evento();
      e.data.transaction.amount_in_cents = 1;

      expect(client().verifyEvent(e)).toBe(false);
    });

    it('rechaza si se altera la marca de tiempo', () => {
      const e = evento();
      e.timestamp = e.timestamp + 1;

      expect(client().verifyEvent(e)).toBe(false);
    });

    it('rechaza un evento sin firma', () => {
      const e = evento() as Record<string, unknown>;
      delete e.signature;

      expect(client().verifyEvent(e)).toBe(false);
    });

    it('rechaza un evento sin checksum', () => {
      const e = evento();
      e.signature.checksum = '' as never;

      expect(client().verifyEvent(e)).toBe(false);
    });

    it('rechaza un evento sin la lista de propiedades firmadas', () => {
      const e = evento() as any;
      delete e.signature.properties;

      expect(client().verifyEvent(e)).toBe(false);
    });

    it('rechaza un evento sin marca de tiempo', () => {
      const e = evento() as any;
      delete e.timestamp;

      expect(client().verifyEvent(e)).toBe(false);
    });

    it('firma exactamente los campos que la pasarela dice haber firmado', () => {
      // Si se ignorara `properties` y se firmara siempre lo mismo, un evento
      // con otra lista pasaría con un checksum que no le corresponde.
      const e = evento({ properties: ['transaction.id'] });

      expect(client().verifyEvent(e)).toBe(true);
      const mentiroso = evento({ properties: ['transaction.id'] });
      mentiroso.signature.properties = ['transaction.status'];
      expect(client().verifyEvent(mentiroso)).toBe(false);
    });

    it('una propiedad que no existe cuenta como vacía, no revienta', () => {
      const timestamp = 1_757_000_000;
      const checksum = createHash('sha256')
        .update(`${timestamp}eventos_secreto`)
        .digest('hex');

      const e = {
        event: 'transaction.updated',
        data: { transaction: { id: 'tx-1' } },
        timestamp,
        signature: { checksum, properties: ['transaction.no_existe'] },
      };

      expect(client().verifyEvent(e)).toBe(true);
    });
  });
});
