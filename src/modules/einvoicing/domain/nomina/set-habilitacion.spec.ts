import { describe, expect, it } from 'vitest';
import {
  PREFIJO_SET_NE,
  SET_NOMINA_EXIGIDO,
  TRABAJADOR_SINTETICO,
  documentoSintetico,
  mesAnteriorA,
  planSetNomina,
  predecesorDeNota,
  reintentarRechazados,
  resumenSetNomina,
} from './set-habilitacion';
import { armarNominaIndividual } from './xml-nomina';

const AHORA = new Date('2026-11-05T15:00:00Z');
const lugar = { departamento: '05', municipio: '05001', direccion: 'Calle 1' };

describe('set de habilitación de nómina', () => {
  it('planea 4 nóminas y 4 notas con prefijos de pruebas distintos de NE/NA', () => {
    const s = planSetNomina('TS-1', AHORA);
    expect(s.documentos.filter((d) => d.tipo === 'nie')).toHaveLength(SET_NOMINA_EXIGIDO.nie);
    expect(s.documentos.filter((d) => d.tipo === 'niae')).toHaveLength(SET_NOMINA_EXIGIDO.niae);
    expect(Object.values(PREFIJO_SET_NE)).not.toContain('NE');
    expect(Object.values(PREFIJO_SET_NE)).not.toContain('NA');
    expect(new Set(s.documentos.map((d) => d.numero)).size).toBe(8);
  });

  it('la nota espera a que su nómina esté aceptada', () => {
    const s = planSetNomina('TS-1', AHORA);
    expect(predecesorDeNota(s, 4)).toBeNull();
    s.documentos[0] = { ...s.documentos[0]!, estado: 'aceptado', cune: 'abc', fecha: '2026-11-05' };
    expect(predecesorDeNota(s, 4)?.cune).toBe('abc');
    expect(predecesorDeNota(s, 5)).toBeNull();
  });

  it('un rechazado vuelve con número nuevo y nunca reusa el enviado', () => {
    const s = planSetNomina('TS-1', AHORA);
    s.documentos[1] = { ...s.documentos[1]!, estado: 'rechazado' };
    const r = reintentarRechazados(s);
    expect(r.documentos[1]!.estado).toBe('pendiente');
    expect(r.documentos[1]!.numero).toBe(s.siguiente);
    expect(r.siguiente).toBe(s.siguiente + 1);
  });

  it('aprueba solo con todos aceptados', () => {
    const s = planSetNomina('TS-1', AHORA);
    expect(resumenSetNomina(s).aprobada).toBe(false);
    s.documentos = s.documentos.map((d) => ({ ...d, estado: 'aceptado' as const }));
    expect(resumenSetNomina(s).aprobada).toBe(true);
  });

  it('mesAnteriorA cruza el año', () => {
    expect(mesAnteriorA('2026-01-15')).toBe('2025-12');
    expect(mesAnteriorA('2026-11-05')).toBe('2026-10');
  });

  it('el documento sintético es rotulado y arma un XML con prefijo de pruebas', () => {
    const doc = documentoSintetico(lugar, '2026-11-05');
    expect(doc.trabajador.primerApellido).toBe('PRUEBA');
    expect(doc.trabajador.numeroDocumento).toBe(TRABAJADOR_SINTETICO.documento);
    const r = armarNominaIndividual(
      {
        emision: {
          fecha: '2026-11-05',
          hora: '10:00:00-05:00',
          prefijo: 'NEP',
          consecutivo: 7,
          empleador: { nit: '900123456', dv: '7', razonSocial: 'X SAS', ...lugar },
        },
        documento: doc,
      },
      { tipoAmbiente: '2', softwareId: 'sw', softwarePin: '12345' },
    );
    expect(r.numero).toBe('NEP7');
  });
});
