import { DOMParser } from '@xmldom/xmldom';
import { beforeAll, describe, expect, it } from 'vitest';
import { p12DePrueba } from '../../domain/p12-de-prueba.test';
import { abrirP12, type MaterialFirma } from '../firma/material-p12';
import { NS_WCF } from './dian.constants';
import { crearDirectoDian, type PeticionHttp, type TransporteHttp } from './directo-dian';
import { nombresArchivoNomina } from './nombre-archivo';
import { respuestaDocumento, respuestaStatusZip, respuestaTestSet } from './respuestas-dian.test';

const PASSWORD = 'clave-de-prueba';
const CUNE = 'c'.repeat(96);
const XML = '<NominaIndividual>firmado</NominaIndividual>';
let material: MaterialFirma;

beforeAll(() => {
  material = abrirP12(p12DePrueba({ password: PASSWORD }), PASSWORD);
});

function falso(cuerpo: string) {
  const llamadas: { url: string; init: PeticionHttp }[] = [];
  const transporte: TransporteHttp = async (url, init) => {
    llamadas.push({ url, init });
    return new Response(cuerpo, { status: 200 });
  };
  return { llamadas, transporte };
}

const directo = (transporte: TransporteHttp, ambiente: '1' | '2' = '1') =>
  crearDirectoDian({
    material,
    tipoAmbiente: ambiente,
    softwareId: 'sw-nomina',
    nit: '800197268',
    transporte,
    reloj: () => new Date('2026-11-05T15:00:00Z'),
  });

function parametros(body: string, op: string): Record<string, string> {
  const nodo = new DOMParser().parseFromString(body, 'text/xml').getElementsByTagNameNS(NS_WCF, op)[0]!;
  const r: Record<string, string> = {};
  for (const h of Array.from(nodo.childNodes)) if (h.nodeType === 1) r[(h as Element).localName] = h.textContent ?? '';
  return r;
}

describe('nombre de archivo de nómina (anexo V1.0)', () => {
  it('nie/niae/z + NIT(10) + aa + hex(8) en mayúsculas, sin código de proveedor', () => {
    const base = { nit: '800197268', anio: 2020, consecutivo: 12 };
    expect(nombresArchivoNomina({ tipo: 'payroll', ...base })).toEqual({
      xml: 'nie0800197268200000000C.xml',
      zip: 'z0800197268200000000C.zip',
    });
    expect(nombresArchivoNomina({ tipo: 'payroll_adjustment', ...base }).xml).toBe('niae0800197268200000000C.xml');
  });

  it('rechaza NIT, año o consecutivo inválidos', () => {
    const base = { tipo: 'payroll', nit: '800197268', anio: 2026, consecutivo: 1 } as const;
    expect(() => nombresArchivoNomina({ ...base, nit: '' })).toThrow();
    expect(() => nombresArchivoNomina({ ...base, consecutivo: 0 })).toThrow();
    expect(() => nombresArchivoNomina({ ...base, anio: 1999 })).toThrow();
  });
});

describe('DirectoDian · nómina', () => {
  it('producción: SendNominaSync con ZIP nie… y veredicto aceptado', async () => {
    const f = falso(respuestaDocumento('SendNominaSync', { isValid: 'true', cufe: CUNE }));
    const r = await directo(f.transporte).enviar({ tipo: 'payroll', fullNumber: 'NE12', cufe: CUNE, xmlFirmado: XML });
    expect(r).toMatchObject({ ok: true, isValid: true, cufe: CUNE });
    const { init } = f.llamadas[0]!;
    expect(init.headers['Content-Type']).toContain('/IWcfDianCustomerServices/SendNominaSync"');
    expect(init.body).not.toContain('SendBillSync');
    const p = parametros(init.body, 'SendNominaSync');
    expect(Object.keys(p)).toEqual(['contentFile']); // SendNominaSync: solo contentFile (anexo v1.0 §9.5)
    const zip = Buffer.from(p.contentFile!, 'base64');
    expect(zip.subarray(30, 30 + zip.readUInt16LE(26)).toString()).toBe('nie0800197268260000000C.xml');
  });

  it('ajuste: el ZIP lleva niae…', async () => {
    const f = falso(respuestaDocumento('SendNominaSync', { isValid: 'true', cufe: CUNE }));
    await directo(f.transporte).enviar({ tipo: 'payroll_adjustment', fullNumber: 'NA3', cufe: CUNE, xmlFirmado: XML });
    const zip = Buffer.from(parametros(f.llamadas[0]!.init.body, 'SendNominaSync').contentFile!, 'base64');
    expect(zip.subarray(30, 30 + zip.readUInt16LE(26)).toString()).toBe('niae08001972682600000003.xml');
  });

  it('rechazo con motivos: isValid=false con los errores de la DIAN', async () => {
    const f = falso(respuestaDocumento('SendNominaSync', { isValid: 'false', statusCode: '99', errores: ['NIAE01: x'], cufe: CUNE }));
    const r = await directo(f.transporte).enviar({ tipo: 'payroll', fullNumber: 'NE12', cufe: CUNE, xmlFirmado: XML });
    expect(r).toMatchObject({ ok: false, isValid: false, origen: 'dian' });
    expect(r.mensajes).toContain('NIAE01: x');
  });

  it('habilitación: SendTestSetAsync con el TestSetId de nómina; sin él no sale a la red', async () => {
    const f = falso(respuestaTestSet('zk-1'));
    const d = directo(f.transporte, '2');
    const base = { tipo: 'payroll', fullNumber: 'NE12', cufe: CUNE, xmlFirmado: XML } as const;
    const sin = await d.enviarSetPruebas({ ...base, testSetId: ' ' });
    expect(sin.codigo).toBe('CONFIG_FALTANTE');
    expect(f.llamadas).toHaveLength(0);
    const r = await d.enviarSetPruebas({ ...base, testSetId: 'ts-nomina-1' });
    expect(r).toMatchObject({ ok: false, zipKey: 'zk-1' });
    const p = parametros(f.llamadas[0]!.init.body, 'SendTestSetAsync');
    expect(p.testSetId).toBe('ts-nomina-1');
    expect(p.fileName).toBe('z0800197268260000000C.zip');
  });

  it('consulta por trackId (GetStatusZip) y por CUNE (GetStatus)', async () => {
    const zip = falso(respuestaStatusZip([{ isValid: 'true', cufe: CUNE }]));
    expect(await directo(zip.transporte, '2').consultar({ trackId: 'zk-1', cufe: CUNE })).toMatchObject({ ok: true });
    expect(zip.llamadas[0]!.init.headers['Content-Type']).toContain('GetStatusZip');
    const st = falso(respuestaDocumento('GetStatus', { isValid: 'true', cufe: CUNE }));
    expect(await directo(st.transporte).consultar({ cufe: CUNE })).toMatchObject({ ok: true });
    expect(st.llamadas[0]!.init.headers['Content-Type']).toContain('GetStatus"');
  });

  it('la factura sigue usando SendBillSync con el nombre con código de proveedor', async () => {
    const f = falso(respuestaDocumento('SendBillSync', { isValid: 'true', cufe: 'x' }));
    await directo(f.transporte).enviar({ tipo: 'invoice', fullNumber: 'FE12', cufe: 'x', xmlFirmado: XML });
    expect(f.llamadas[0]!.init.headers['Content-Type']).toContain('SendBillSync');
    expect(parametros(f.llamadas[0]!.init.body, 'SendBillSync').fileName).toMatch(/^z0800197268000/);
  });
});
