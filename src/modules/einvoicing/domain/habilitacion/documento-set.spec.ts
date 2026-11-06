import { describe, expect, it } from 'vitest';
import { armarDocumentoSet, ventaSintetica, type EmisorParaSet } from './documento-set';
import { DocumentoUblInvalidoError } from '../ubl/xml-ubl';
import { documentoDeVenta } from '../documento-venta';

const EMISOR: EmisorParaSet = {
  razonSocial: 'Crunchy Pruebas S.A.S.',
  nit: '900123456-8',
  nitNorm: '900123456',
  nitDv: '8',
  tipoPersona: 'juridica',
  responsabilidadFiscal: 'responsable_iva',
  direccion: 'Calle 10 # 43-12',
  ciudad: 'Medellín',
  departamento: 'Antioquia',
  telefono: '6041234567',
  emailFacturacion: 'facturacion@crunchy.co',
  municipioDane: '05001',
  responsableIva: true,
};
const entrada = (tipo: 'fv' | 'pos', posicion: number) => ({
  tipo,
  numero: 990_000_123 + posicion,
  posicion,
  fecha: '2026-11-06',
  hora: '10:15:00-05:00',
  emisor: EMISOR,
  softwareId: '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0',
  softwarePin: '12345',
});

describe('armarDocumentoSet', () => {
  it('arma las 8 combinaciones de factura con SETP y CUFE de 96 hex', () => {
    for (let i = 0; i < 8; i++) {
      const r = armarDocumentoSet(entrada('fv', i));
      expect(r.numeroCompleto).toBe(`SETP${990_000_123 + i}`);
      expect(r.codigo).toMatch(/^[0-9a-f]{96}$/);
      expect(r.xml).toContain('<sts:Prefix>SETP</sts:Prefix>');
      expect(r.xml).toContain(r.codigo);
      expect(r.xml).toContain('800197268');
    }
  });

  it('cubre IVA 19, INC 8 y exento en el conjunto', () => {
    const vistos = new Set<string>();
    for (let i = 0; i < 8; i++) for (const l of documentoDeVenta(ventaSintetica(i)).lines) vistos.add(`${l.taxScheme}:${l.taxRate}`);
    expect([...vistos].sort()).toEqual(['01:0', '01:19', '04:8']);
  });

  it('el POS usa el CUDE con el PIN: cambia con el PIN y la factura no', () => {
    const a = armarDocumentoSet(entrada('pos', 0));
    const b = armarDocumentoSet({ ...entrada('pos', 0), softwarePin: '99999' });
    expect(a.codigo).not.toBe(b.codigo);
    const f1 = armarDocumentoSet(entrada('fv', 0));
    const f2 = armarDocumentoSet({ ...entrada('fv', 0), softwarePin: '99999' });
    expect(f1.codigo).toBe(f2.codigo);
  });

  it('un emisor incompleto es DocumentoUblInvalidoError, sin PIN en el mensaje', () => {
    try {
      armarDocumentoSet({ ...entrada('fv', 0), emisor: { ...EMISOR, direccion: undefined } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentoUblInvalidoError);
      expect((err as Error).message).not.toContain('12345');
    }
  });

  it('las notas todavía no tienen armador', () => {
    expect(() => armarDocumentoSet({ ...entrada('fv', 0), tipo: 'nc' as never })).toThrow(/armador/);
  });
});
