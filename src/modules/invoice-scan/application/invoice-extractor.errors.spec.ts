import { describe, it, expect } from 'vitest';
import { providerErrorMessage } from './invoice-extractor';

/**
 * Qué se le dice a quien sube una factura cuando el proveedor la rechaza.
 *
 * Estos tests fijan una distinción que costó dos días de diagnóstico: un id de
 * modelo inexistente, una cuenta sin acceso contratado y una cuenta sin saldo
 * devolvían el MISMO "Inténtalo de nuevo en un momento", y ninguno de los tres
 * se arregla reintentando. Las respuestas de abajo son literales, capturadas de
 * DashScope y de Z.ai contra cuentas reales.
 */
describe('providerErrorMessage · el 503 tiene que decir qué hacer', () => {
  it('sin saldo (Z.ai) manda avisar al administrador, no reintentar', () => {
    const msg = providerErrorMessage(
      429,
      '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}',
    );

    expect(msg).toMatch(/sin cupo|saldo/i);
    expect(msg).toMatch(/administrador/i);
    expect(msg).not.toMatch(/inténtalo de nuevo en un momento/i);
  });

  it('acceso no contratado (Alibaba) cae en el mismo aviso de cupo', () => {
    const msg = providerErrorMessage(
      403,
      '{"code":"AccessDenied.Unpurchased","message":"Access to model denied. Please make sure you are eligible for using the model."}',
    );

    expect(msg).toMatch(/sin cupo|saldo|acceso/i);
    expect(msg).toMatch(/administrador/i);
  });

  it('modelo inexistente se señala como configuración, no como caída', () => {
    const msg = providerErrorMessage(
      400,
      '{"code":"InvalidParameter","message":"Model not exist."}',
    );

    expect(msg).toMatch(/modelo/i);
    expect(msg).toMatch(/configurad|entorno/i);
  });

  it('llave inválida sugiere lo que casi siempre es: otra región', () => {
    const msg = providerErrorMessage(
      401,
      '{"code":"InvalidApiKey","message":"Invalid API-key provided."}',
    );

    expect(msg).toMatch(/llave/i);
    expect(msg).toMatch(/región/i);
  });

  it('saturación SÍ invita a reintentar, que es lo único que aquí sirve', () => {
    const msg = providerErrorMessage(429, '{"message":"Too many requests"}');

    expect(msg).toMatch(/reintenta|espera/i);
  });

  it('lo desconocido conserva el mensaje neutro de siempre', () => {
    const msg = providerErrorMessage(500, '{"message":"boom"}');

    expect(msg).toBe(
      'No se pudo leer la factura. Inténtalo de nuevo en un momento.',
    );
  });

  it('el saldo agotado gana sobre el 429 genérico, aunque compartan status', () => {
    // Z.ai devuelve 429 para "sin saldo". Si el orden de las reglas se
    // invirtiera, el usuario leería "espera y reintenta" para siempre.
    const msg = providerErrorMessage(429, 'insufficient balance, please recharge');

    expect(msg).toMatch(/administrador/i);
    expect(msg).not.toMatch(/espera un momento/i);
  });
});
