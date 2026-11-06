import { describe, expect, it } from 'vitest';
import { llevaDocumentoPos, mismaSemanaColombia, puedeAnularPos } from './ventana-anulacion';

/** Hora de Colombia (UTC−5) como instante UTC. */
const co = (fecha: string, hora = '12:00') => new Date(`${fecha}T${hora}:00-05:00`);

const POS = { solicitado: 'pos_anonimo', estado: 'emitido', tipo: 'pos' } as const;

describe('ventana de anulación del POS (decisión 6: misma semana calendario)', () => {
  it('lunes y domingo de la misma semana: se anula', () => {
    // 2026-11-02 es lunes; 2026-11-08, domingo.
    expect(mismaSemanaColombia(co('2026-11-02', '00:05'), co('2026-11-08', '23:59'))).toBe(true);
    expect(puedeAnularPos({ fecha: co('2026-11-02'), documentoFiscal: POS }, co('2026-11-08', '23:59'))).toBe(true);
  });

  it('domingo y el lunes siguiente: ya no (aunque sea un día después)', () => {
    expect(mismaSemanaColombia(co('2026-11-08', '23:00'), co('2026-11-09', '00:01'))).toBe(false);
    expect(puedeAnularPos({ fecha: co('2026-11-08', '23:00'), documentoFiscal: POS }, co('2026-11-09', '00:01'))).toBe(false);
  });

  it('cuenta la hora de Colombia, no la UTC: el domingo 9 p. m. sigue siendo domingo', () => {
    // Domingo 21:00 en Colombia = lunes 02:00 UTC. En UTC parecería la semana siguiente.
    const venta = co('2026-11-08', '21:00');
    expect(venta.getUTCDay()).toBe(1);
    expect(mismaSemanaColombia(venta, co('2026-11-02', '08:00'))).toBe(true);
    expect(mismaSemanaColombia(venta, co('2026-11-09', '08:00'))).toBe(false);
  });

  it('cruza fin de mes y de año sin romperse', () => {
    // 2026-12-28 lunes … 2027-01-03 domingo.
    expect(mismaSemanaColombia(co('2026-12-28'), co('2027-01-03'))).toBe(true);
    expect(mismaSemanaColombia(co('2027-01-03'), co('2027-01-04'))).toBe(false);
  });

  it('sin POS (FEV o sin documento) no hay ventana', () => {
    const vieja = co('2026-01-05');
    const hoy = co('2026-11-06');
    expect(puedeAnularPos({ fecha: vieja }, hoy)).toBe(true);
    expect(puedeAnularPos({ fecha: vieja, documentoFiscal: { solicitado: 'fev', estado: 'emitido', tipo: 'invoice' } }, hoy)).toBe(true);
    // El POS que falló no dejó documento: se anula como cualquier venta.
    expect(puedeAnularPos({ fecha: vieja, documentoFiscal: { solicitado: 'pos_anonimo', estado: 'error' } }, hoy)).toBe(true);
  });

  it('el POS en proceso o pendiente de contingencia sí cuenta como POS', () => {
    expect(llevaDocumentoPos({ solicitado: 'pos_identificado', estado: 'en_proceso' })).toBe(true);
    expect(llevaDocumentoPos({ solicitado: 'pos_anonimo', estado: 'pendiente_contingencia_07' })).toBe(true);
    expect(llevaDocumentoPos(null)).toBe(false);
  });
});
