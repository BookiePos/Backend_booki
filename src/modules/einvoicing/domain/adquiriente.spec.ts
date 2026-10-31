import { describe, expect, it } from 'vitest';
import {
  adquirientePos,
  buildAdquiriente,
  validarAdquirienteParaFactura,
  type ClienteVenta,
} from './adquiriente';

const completo: ClienteVenta = {
  name: 'Bancolombia S.A.',
  idNumber: '890903938',
  docType: '31',
  nitDv: '8',
  tipoPersona: '1',
  responsabilidades: ['O-13', 'O-15'],
  municipioDane: '05001',
  address: 'Cra 48 26-85',
  emailFacturacion: 'facturas@banco.example',
};

describe('buildAdquiriente', () => {
  it('sin cliente: consumidor final', () => {
    expect(buildAdquiriente(undefined)).toMatchObject({
      docType: '13',
      docNumber: '222222222222',
      responsabilidades: ['R-99-PN'],
    });
  });

  it('con nombre pero sin documento: consumidor final', () => {
    expect(buildAdquiriente({ name: 'Ana' }).docNumber).toBe('222222222222');
  });

  it('número sin tipo de documento: no adivina, consumidor final', () => {
    const a = buildAdquiriente({ name: 'Ana', idNumber: '12345678901234' });
    expect(a.docType).toBe('13');
    expect(a.docNumber).toBe('222222222222');
  });

  it('NIT con datos capturados', () => {
    const a = buildAdquiriente(completo);
    expect(a).toMatchObject({
      docType: '31',
      docNumber: '890903938',
      nitDv: '8',
      tipoPersona: '1',
      municipioDane: '05001',
      email: 'facturas@banco.example',
    });
  });

  it('NIT escrito con guion toma el DV del número', () => {
    const a = buildAdquiriente({ ...completo, idNumber: '890.903.938-8', nitDv: undefined });
    expect(a.docNumber).toBe('890903938');
    expect(a.nitDv).toBe('8');
  });

  it('cédula de 11 dígitos sigue siendo la que dice el tipo', () => {
    const a = buildAdquiriente({ name: 'Luis', idNumber: '12345678901', docType: '13' });
    expect(a.docType).toBe('13');
    expect(a.nitDv).toBeUndefined();
  });

  it('pasaporte conserva el tipo', () => {
    expect(buildAdquiriente({ name: 'J', idNumber: 'AB123', docType: '41' }).docType).toBe('41');
  });
});

describe('número de documento por tipo', () => {
  it('cédula: solo dígitos y sin ceros a la izquierda', () => {
    const a = buildAdquiriente({ name: 'Ana', idNumber: '0012.345-678', docType: '13' });
    expect(a.docNumber).toBe('12345678');
  });
  it.each(['11', '12', '91'])('tipo %s también se normaliza', (t) => {
    expect(buildAdquiriente({ name: 'N', idNumber: '00987', docType: t }).docNumber).toBe('987');
  });
  it('tipos extranjeros conservan letras y ceros', () => {
    expect(buildAdquiriente({ name: 'J', idNumber: 'ab0123', docType: '41' }).docNumber).toBe('ab0123');
  });
  it('número sin dígitos en tipo numérico se reporta', () => {
    const r = validarAdquirienteParaFactura({ ...completo, docType: '13', idNumber: '000' });
    expect(r.faltantes.join(' ')).toContain('número de documento');
  });
  it('el código 43 ya no es un tipo válido', () => {
    const r = validarAdquirienteParaFactura({ ...completo, docType: '43' });
    expect(r.faltantes).toContain('tipo de documento');
  });
});

describe('validarAdquirienteParaFactura', () => {
  it('cliente completo: nada falta', () => {
    expect(validarAdquirienteParaFactura(completo)).toEqual({
      esConsumidorFinal: false,
      faltantes: [],
    });
  });

  it('sin cliente: consumidor final', () => {
    expect(validarAdquirienteParaFactura(undefined).esConsumidorFinal).toBe(true);
  });

  it('número sin tipo: lista el tipo y lo demás', () => {
    const r = validarAdquirienteParaFactura({ name: 'Ana', idNumber: '123' });
    expect(r.faltantes).toContain('tipo de documento');
    expect(r.faltantes).toContain('municipio (código DANE de 5 dígitos)');
  });

  it('DV malo dice qué corregir', () => {
    const r = validarAdquirienteParaFactura({ ...completo, nitDv: '3' });
    expect(r.faltantes.join(' ')).toContain('debería ser 8');
  });

  it('municipio inválido y responsabilidad desconocida', () => {
    const r = validarAdquirienteParaFactura({
      ...completo,
      municipioDane: '5001',
      responsabilidades: ['X-1'],
    });
    expect(r.faltantes).toEqual([
      'responsabilidades fiscales',
      'municipio (código DANE de 5 dígitos)',
    ]);
  });
});

describe('adquirientePos', () => {
  it('anónimo: consumidor final aunque la venta traiga datos del cliente', () => {
    const r = adquirientePos(completo, 'anonimo');
    expect(r.faltantes).toEqual([]);
    expect(r.adquiriente).toMatchObject({
      docType: '13',
      docNumber: '222222222222',
      name: 'Consumidor final',
    });
  });

  it('identificado: basta nombre, tipo y número (y DV si es NIT); no pide la ficha fiscal completa', () => {
    const r = adquirientePos(
      { name: 'Ana Pérez', idNumber: '1.020.304.050', docType: '13' },
      'identificado',
    );
    expect(r.faltantes).toEqual([]);
    expect(r.adquiriente).toMatchObject({
      docType: '13',
      docNumber: '1020304050',
      name: 'Ana Pérez',
    });
  });

  it('identificado con NIT: exige el DV correcto', () => {
    expect(
      adquirientePos({ name: 'Bancolombia', idNumber: '890903938', docType: '31', nitDv: '8' }, 'identificado')
        .adquiriente,
    ).toMatchObject({ docType: '31', docNumber: '890903938', nitDv: '8' });
    const malo = adquirientePos(
      { name: 'Bancolombia', idNumber: '890903938', docType: '31', nitDv: '1' },
      'identificado',
    );
    expect(malo.adquiriente).toBeUndefined();
    expect(malo.faltantes.join(' ')).toMatch(/DV/);
  });

  it('identificado sin datos: dice qué falta y no inventa un consumidor final', () => {
    const r = adquirientePos({ name: '  ' }, 'identificado');
    expect(r.adquiriente).toBeUndefined();
    expect(r.faltantes).toEqual(
      expect.arrayContaining(['nombre o razón social', 'tipo de documento', 'número de documento']),
    );
  });
});
