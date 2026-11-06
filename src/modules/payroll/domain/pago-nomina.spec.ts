import { describe, expect, it } from 'vitest';
import { motivoPagoInvalido } from './pago-nomina';

describe('motivoPagoInvalido (decisión 1 del dueño: medio y fecha real del pago)', () => {
  const hoy = '2026-11-06';
  it('acepta efectivo, cheque, consignación y transferencia dentro del rango', () => {
    for (const m of ['10', '20', '42', '47']) expect(motivoPagoInvalido('2026-10', m, '2026-10-31', hoy)).toBeNull();
    expect(motivoPagoInvalido('2026-10', '10', hoy, hoy)).toBeNull();
  });
  it('rechaza medios que no son de nómina', () => {
    expect(motivoPagoInvalido('2026-10', '48', '2026-10-31', hoy)).toMatch(/medio de pago/);
    expect(motivoPagoInvalido('2026-10', '', '2026-10-31', hoy)).toMatch(/medio de pago/);
  });
  it('rechaza fechas inexistentes, anteriores al mes o futuras', () => {
    expect(motivoPagoInvalido('2026-10', '10', '2026-02-30', hoy)).toMatch(/no es una fecha válida/);
    expect(motivoPagoInvalido('2026-10', '10', '31/10/2026', hoy)).toMatch(/no es una fecha válida/);
    expect(motivoPagoInvalido('2026-10', '10', '2026-09-30', hoy)).toMatch(/anterior al mes liquidado/);
    expect(motivoPagoInvalido('2026-10', '10', '2026-11-07', hoy)).toMatch(/futura/);
  });
});
