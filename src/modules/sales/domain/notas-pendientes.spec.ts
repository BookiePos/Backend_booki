import { describe, expect, it } from 'vitest';
import { anulacionSinNota, FILTRO_RETORNO_SIN_NOTA } from './notas-pendientes';

describe('notas pendientes de una venta', () => {
  it('la anulación pendiente es la de una venta anulada sin nota emitida', () => {
    expect(anulacionSinNota({ status: 'void' })).toBe(true);
    expect(anulacionSinNota({ status: 'void', notaAnulacion: { estado: 'sin_nota' } })).toBe(true);
    expect(anulacionSinNota({ status: 'void', notaAnulacion: { estado: 'emitida' } })).toBe(false);
    expect(anulacionSinNota({ status: 'completed' })).toBe(false);
  });
  it('el filtro de devoluciones excluye las ya emitidas', () => {
    expect(FILTRO_RETORNO_SIN_NOTA).toEqual({ 'notaFiscal.estado': { $ne: 'emitida' } });
  });
});
