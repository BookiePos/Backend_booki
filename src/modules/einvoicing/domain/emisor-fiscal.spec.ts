import { describe, expect, it } from 'vitest';
import {
  certificadoVigente,
  datosEmisorDeSede,
  diferenciasFiscales,
  estadoDeEmisor,
  fusionarDatosEmisor,
  type EmisorParaEstado,
} from './emisor-fiscal';
import { resolverTransmisor } from './resolver-transmisor';
import { StubDian } from './stub-dian';

const sede = {
  name: 'Sede Centro',
  businessName: 'Crunchy SAS',
  nit: '900.123.456-7',
  nitDv: '7',
  tipoPersona: 'juridica',
  responsabilidadFiscal: 'responsable_iva',
  responsableIva: true,
  responsableInc: true,
  franquicia: false,
  regimenRenta: 'ordinario',
  ciiu: '5611',
  address: 'Cra 1 # 2-3',
  departamento: 'Antioquia',
  ciudad: 'Medellín',
  phone: '3000000000',
  emailFacturacion: 'FE@Crunchy.co',
};

describe('datosEmisorDeSede', () => {
  it('copia lo que tiene la sede y normaliza el NIT', () => {
    const d = datosEmisorDeSede(sede)!;
    expect(d.nitNorm).toBe('900123456');
    expect(d.nit).toBe('900.123.456-7');
    expect(d.razonSocial).toBe('Crunchy SAS');
    expect(d.direccion).toBe('Cra 1 # 2-3');
    expect(d.telefono).toBe('3000000000');
    expect(d.emailFacturacion).toBe('fe@crunchy.co');
    expect(d.responsableInc).toBe(true);
    expect(d.ciiu).toBe('5611');
  });

  it('sin nombre comercial usa el nombre de la sede, como buildEmisor', () => {
    expect(datosEmisorDeSede({ ...sede, businessName: ' ' })!.razonSocial).toBe('Sede Centro');
  });

  it.each([undefined, '', '  ', 'sin-nit'])('sin NIT utilizable (%s) devuelve null', (nit) => {
    expect(datosEmisorDeSede({ ...sede, nit })).toBeNull();
  });
});

describe('diferenciasFiscales y fusionarDatosEmisor', () => {
  const a = datosEmisorDeSede(sede)!;

  it('mayúsculas y espacios no son diferencia', () => {
    const b = datosEmisorDeSede({ ...sede, businessName: '  crunchy   sas ' })!;
    expect(diferenciasFiscales(a, b)).toEqual([]);
  });

  it('razón social o responsabilidades distintas son conflicto y no se elige', () => {
    const b = datosEmisorDeSede({ ...sede, businessName: 'Otra SAS', responsableInc: false })!;
    const f = fusionarDatosEmisor([a, b]);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.conflictos).toEqual(['razonSocial', 'responsableInc']);
  });

  it('el contacto distinto no es conflicto: se deja vacío y se informa', () => {
    const b = datosEmisorDeSede({ ...sede, address: 'Calle 9', phone: '3111111111' })!;
    const f = fusionarDatosEmisor([a, b]);
    expect(f.ok).toBe(true);
    if (f.ok) {
      expect(f.datos.direccion).toBeUndefined();
      expect(f.datos.telefono).toBeUndefined();
      expect(f.datos.ciudad).toBe('Medellín');
      expect(f.contactoOmitido).toEqual(['direccion', 'telefono']);
    }
  });

  it('una sola sede pasa entera', () => {
    const f = fusionarDatosEmisor([a]);
    expect(f.ok && f.datos).toEqual(a);
  });

  it('lista vacía no fusiona', () => {
    expect(fusionarDatosEmisor([]).ok).toBe(false);
  });
});

describe('estadoDeEmisor', () => {
  const ahora = new Date('2026-10-28T12:00:00Z');
  const completo: EmisorParaEstado = {
    razonSocial: 'Crunchy SAS',
    nitDv: '7',
    tipoPersona: 'juridica',
    direccion: 'Cra 1',
    municipioDane: '05001',
    emailFacturacion: 'fe@crunchy.co',
    facturaSoftwareId: 'sw-1',
    facturaTestSetId: 'ts-1',
    certPath: 'certs/x.p12',
    certVenceAt: new Date('2027-01-01'),
    tipoAmbiente: '2',
    habilitado: false,
    tieneFacturaPin: true,
    tieneCertPassword: true,
  };

  it('completo no le falta nada para transmitir', () => {
    const e = estadoDeEmisor(completo, ahora);
    expect(e.faltaParaTransmitir).toEqual([]);
    expect(e.datosFiscalesFaltantes).toEqual([]);
    expect(e).toMatchObject({ certificadoVigente: true, softwareId: 'sw-1', tienePin: true });
    expect(e.tieneTestSetId).toBe(true);
  });

  it.each([
    ['vencido', { certVenceAt: new Date('2026-10-01') }],
    ['sin fecha', { certVenceAt: undefined }],
    ['sin archivo', { certPath: undefined }],
    ['sin contraseña', { tieneCertPassword: false }],
  ])('certificado %s no está vigente', (_n, cambio) => {
    expect(certificadoVigente({ ...completo, ...cambio }, ahora)).toBe(false);
  });

  it('enumera lo que falta y alimenta resolverTransmisor', async () => {
    const e = estadoDeEmisor(
      { tieneFacturaPin: false, tieneCertPassword: false, facturaSoftwareId: ' ' },
      ahora,
    );
    expect(e.faltaParaTransmitir).toEqual(['certificado .p12 vigente', 'SoftwareID', 'PIN del software']);
    expect(e.datosFiscalesFaltantes).toContain('municipio DANE');
    expect(e.tipoAmbiente).toBe('2');
    expect(e.habilitado).toBe(false);
    const t = resolverTransmisor(e);
    expect(t).toBeInstanceOf(StubDian);
    const r = await t.enviar({ tipo: 'invoice', fullNumber: 'FE1' });
    expect(r.mensajes.join(' ')).toContain('SoftwareID');
  });

  it('el ambiente de producción se respeta; cualquier otro valor cae a habilitación', () => {
    expect(estadoDeEmisor({ ...completo, tipoAmbiente: '1' }, ahora).tipoAmbiente).toBe('1');
    expect(estadoDeEmisor({ ...completo, tipoAmbiente: 'x' }, ahora).tipoAmbiente).toBe('2');
  });
});
