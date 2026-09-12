import { describe, it, expect } from 'vitest';
import { MAX_DELIVERY_FEE, resolveDelivery } from './delivery.constants';

/**
 * Cuánto se cobra por llevar el pedido.
 *
 * Son zonas con precio fijo y nada de kilómetros — decisión tomada con el
 * dueño: una API de mapas se paga todos los meses y en Medellín se equivoca,
 * porque dos direcciones a 800 metros en línea recta pueden tener una montaña
 * en medio.
 *
 * Lo que se protege aquí:
 *
 * - Que la ZONA mande sobre el valor escrito a mano. Si no, el precio del
 *   domicilio depende de quién tome el pedido, y las zonas existen justamente
 *   para que no dependa de eso.
 * - Que un domicilio no se pueda registrar sin dirección. El cobro quedaría
 *   hecho igual y nadie sabría a dónde llevarlo.
 */
describe('resolveDelivery · qué se cobra por llevarlo', () => {
  const laureles = { id: 'z1', name: 'Laureles', fee: 5_000 };
  const base = { address: 'Calle 33 #70-20' };

  it('con zona se cobra la tarifa de la zona', () => {
    const r = resolveDelivery(base, laureles);
    expect(r.fee).toBe(5_000);
    expect(r.zoneName).toBe('Laureles');
    expect(r.zoneId).toBe('z1');
  });

  it('la zona manda sobre el valor escrito a mano', () => {
    // Si ganara el valor a mano, el precio del domicilio dependería de quién
    // tome el pedido — que es justo lo que las zonas vienen a evitar.
    const r = resolveDelivery({ ...base, fee: 2_000 }, laureles);
    expect(r.fee).toBe(5_000);
  });

  it('sin zona vale el valor escrito a mano: es la casilla que se acordó', () => {
    const r = resolveDelivery({ ...base, fee: 12_000 }, null);
    expect(r.fee).toBe(12_000);
    expect(r.zoneId).toBeUndefined();
  });

  it('sin zona ni valor, el domicilio va gratis', () => {
    // Es una decisión comercial válida y bastante común, no un error.
    expect(resolveDelivery(base, null).fee).toBe(0);
  });

  it('una zona que ya no existe es un error, no un domicilio gratis', () => {
    // Cobrar cero porque alguien desactivó la zona sería regalar el envío sin
    // que nadie lo decidiera.
    expect(() =>
      resolveDelivery({ ...base, zoneId: 'z-borrada' }, null),
    ).toThrow(/no existe o está desactivada/i);
  });

  it('un domicilio sin dirección no se registra', () => {
    expect(() => resolveDelivery({ fee: 5_000 }, null)).toThrow(
      /necesita la dirección/i,
    );
    expect(() => resolveDelivery({ address: '   ' }, laureles)).toThrow(
      /necesita la dirección/i,
    );
  });

  it('rechaza un valor negativo', () => {
    expect(() => resolveDelivery({ ...base, fee: -1_000 }, null)).toThrow(
      /no puede ser negativo/i,
    );
  });

  it('rechaza un valor absurdo, que casi siempre es un cero de más', () => {
    expect(() =>
      resolveDelivery({ ...base, fee: MAX_DELIVERY_FEE + 1 }, null),
    ).toThrow(/demasiado alto/i);
  });

  it('limpia los espacios y descarta los campos vacíos', () => {
    const r = resolveDelivery(
      {
        address: '  Carrera 70 #45-12  ',
        phone: '  3001234567 ',
        notes: '   ',
        courier: '',
      },
      laureles,
    );
    expect(r.address).toBe('Carrera 70 #45-12');
    expect(r.phone).toBe('3001234567');
    expect(r.notes).toBeUndefined();
    expect(r.courier).toBeUndefined();
  });

  it('el valor a mano se redondea a peso entero', () => {
    expect(resolveDelivery({ ...base, fee: 5_500.4 }, null).fee).toBe(5_500);
  });
});
