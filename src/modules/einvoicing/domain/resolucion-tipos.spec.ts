import { describe, it, expect } from 'vitest';
import {
  TIPOS_RESOLUCION,
  contadorDeResolucion,
  resolucionDeTipo,
} from './resolucion-tipos';

describe('resoluciones por tipo de documento', () => {
  it('los tipos son factura, POS, nota crédito, nota débito y contingencia', () => {
    expect([...TIPOS_RESOLUCION]).toEqual([
      'invoice',
      'pos',
      'credit_note',
      'debit_note',
      'contingency',
    ]);
  });

  it('la factura sale de resolucionFe: las sedes existentes siguen siendo factura', () => {
    const sede = { resolucionFe: { prefijo: 'FE' }, resolucionesFe: [] };
    expect(resolucionDeTipo(sede, 'invoice')).toEqual({ prefijo: 'FE' });
    expect(resolucionDeTipo(sede, 'credit_note')).toBeUndefined();
  });

  it('los demás tipos salen de resolucionesFe, uno por tipo', () => {
    const sede = {
      resolucionFe: { prefijo: 'FE' },
      resolucionesFe: [
        { tipoDocumento: 'pos' as const, prefijo: 'POS' },
        { tipoDocumento: 'credit_note' as const, prefijo: 'NC' },
      ],
    };
    expect(resolucionDeTipo(sede, 'pos')?.prefijo).toBe('POS');
    expect(resolucionDeTipo(sede, 'credit_note')?.prefijo).toBe('NC');
    expect(resolucionDeTipo(sede, 'debit_note')).toBeUndefined();
  });

  it('sin resolucionesFe (sede vieja) no revienta', () => {
    expect(resolucionDeTipo({ resolucionFe: null }, 'pos')).toBeUndefined();
    expect(resolucionDeTipo({}, 'invoice')).toBeUndefined();
  });

  it('el contador de la factura conserva su id histórico; los demás llevan el tipo', () => {
    expect(contadorDeResolucion('invoice', 's1', 'FE')).toBe('fe:s1:FE');
    expect(contadorDeResolucion('invoice', 's1', undefined)).toBe('fe:s1:');
    expect(contadorDeResolucion('pos', 's1', 'FE')).toBe('fe:pos:s1:FE');
    expect(contadorDeResolucion('credit_note', 's1', 'NC')).not.toBe(
      contadorDeResolucion('debit_note', 's1', 'NC'),
    );
  });
});
