import { DOMParser } from '@xmldom/xmldom';
import { inspect } from 'util';
import { inflateRawSync } from 'zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { p12DePrueba } from '../../domain/p12-de-prueba.test';
import { assertContratoRespuesta } from '../../domain/transmisor-dian';
import { abrirP12, type MaterialFirma } from '../firma/material-p12';
import { MAX_BYTES_RESPUESTA, NS_WCF, URL_DIAN_POR_AMBIENTE } from './dian.constants';
import { crearDirectoDian, DirectoDian, type PeticionHttp, type TransporteHttp } from './directo-dian';
import { CLAVE_TECNICA_PRUEBA, faultSoap, respuestaDocumento, respuestaRangos, respuestaTestSet } from './respuestas-dian.test';

const PASSWORD = 'clave-de-prueba';
let material: MaterialFirma;

beforeAll(() => {
  material = abrirP12(p12DePrueba({ password: PASSWORD }), PASSWORD);
});

interface Llamada {
  url: string;
  init: PeticionHttp;
}

/** Transporte falso: registra la llamada y responde lo que se le diga. */
function falso(status: number, cuerpo: string): { transporte: TransporteHttp; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  return {
    llamadas,
    transporte: async (url, init) => {
      llamadas.push({ url, init });
      // Como `fetch`: cuerpo en streaming (el único que se acepta).
      return new Response(cuerpo, { status });
    },
  };
}

function directo(transporte: TransporteHttp, extra: Partial<Parameters<typeof crearDirectoDian>[0]> = {}): DirectoDian {
  return crearDirectoDian({
    material,
    tipoAmbiente: '2',
    softwareId: 'soft-123',
    nit: '900123456',
    transporte,
    reloj: () => new Date('2026-10-30T15:00:00Z'),
    ...extra,
  });
}

function parametros(body: string, op: string): Record<string, string> {
  const doc = new DOMParser().parseFromString(body, 'text/xml');
  const nodo = doc.getElementsByTagNameNS(NS_WCF, op)[0]!;
  const r: Record<string, string> = {};
  for (const h of Array.from(nodo.childNodes)) {
    if (h.nodeType === 1) r[(h as Element).localName] = h.textContent ?? '';
  }
  return r;
}

const XML_FIRMADO = '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">firmado</Invoice>';

describe('DirectoDian', () => {
  it('elige la URL solo por el ambiente del emisor', async () => {
    for (const amb of ['1', '2'] as const) {
      const f = falso(200, respuestaDocumento('GetStatus', { isValid: 'true' }));
      const d = directo(f.transporte, { tipoAmbiente: amb });
      expect(d.urlServicio).toBe(URL_DIAN_POR_AMBIENTE[amb]);
      await d.consultar({ cufe: 'c' });
      expect(f.llamadas[0]!.url).toBe(URL_DIAN_POR_AMBIENTE[amb]);
      expect(f.llamadas[0]!.init.body).toContain(`<wsa:To wsu:Id=`);
      expect(f.llamadas[0]!.init.body).toContain(`>${URL_DIAN_POR_AMBIENTE[amb]}</wsa:To>`);
    }
    expect(() => directo(falso(200, '').transporte, { tipoAmbiente: '3' as never })).toThrow(/Ambiente/);
    expect(() => directo(falso(200, '').transporte, { tipoAmbiente: undefined as never })).toThrow(/Ambiente/);
    expect(() => directo(falso(200, '').transporte, { softwareId: ' ' })).toThrow();
    expect(() => directo(falso(200, '').transporte, { nit: '' })).toThrow();
  });

  it('SendBillSync: ZIP base64 con el XML firmado y nombres de la convención', async () => {
    const f = falso(200, respuestaDocumento('SendBillSync', { isValid: 'true', cufe: 'cufe-1' }));
    const r = await directo(f.transporte).enviar({ tipo: 'invoice', fullNumber: 'SETP990000001', xmlFirmado: XML_FIRMADO });
    expect(r).toMatchObject({ ok: true, isValid: true, cufe: 'cufe-1' });
    const { init } = f.llamadas[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toContain('action="http://wcf.dian.colombia/IWcfDianCustomerServices/SendBillSync"');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const p = parametros(init.body, 'SendBillSync');
    expect(p.fileName).toBe('z0900123456000263b023381.zip');
    const zip = Buffer.from(p.contentFile!, 'base64');
    const largoNombre = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + largoNombre).toString()).toBe('fv0900123456000263b023381.xml');
    const comp = zip.readUInt32LE(18);
    expect(inflateRawSync(zip.subarray(30 + largoNombre, 30 + largoNombre + comp)).toString()).toBe(XML_FIRMADO);
  });

  it('SendTestSetAsync lleva testSetId y deja el documento pendiente con zipKey', async () => {
    const f = falso(200, respuestaTestSet('zk-1'));
    const r = await directo(f.transporte).enviarSetPruebas({
      tipo: 'invoice',
      fullNumber: 'SETP990000002',
      xmlFirmado: XML_FIRMADO,
      testSetId: 'set-abc',
    });
    expect(r).toMatchObject({ codigo: 'PENDIENTE_DIAN', zipKey: 'zk-1', trackId: 'zk-1' });
    const p = parametros(f.llamadas[0]!.init.body, 'SendTestSetAsync');
    expect(Object.keys(p)).toEqual(['fileName', 'contentFile', 'testSetId']);
    expect(p.testSetId).toBe('set-abc');
  });

  it('consultar: trackId → GetStatusZip, CUFE → GetStatus', async () => {
    const f = falso(200, '<x/>');
    const d = directo(f.transporte);
    await d.consultar({ trackId: 'zk-1' });
    await d.consultar({ cufe: 'cufe-9' });
    expect(parametros(f.llamadas[0]!.init.body, 'GetStatusZip')).toEqual({ trackId: 'zk-1' });
    expect(parametros(f.llamadas[1]!.init.body, 'GetStatus')).toEqual({ trackId: 'cufe-9' });
  });

  it('rangos: accountCode, accountCodeT y softwareCode', async () => {
    const f = falso(200, respuestaRangos());
    const r = await directo(f.transporte, { nitProveedor: '800111222' }).rangos('900.123.456');
    expect(parametros(f.llamadas[0]!.init.body, 'GetNumberingRange')).toEqual({
      accountCode: '900123456',
      accountCodeT: '800111222',
      softwareCode: 'soft-123',
    });
    expect(r.rangos[0]!.claveTecnica).toBe(CLAVE_TECNICA_PRUEBA);
    expect(JSON.stringify(r)).not.toContain(CLAVE_TECNICA_PRUEBA);
  });

  it('sin XML, sin testSetId o sin identificador → CONFIG_FALTANTE y nada sale a la red', async () => {
    const f = falso(200, '');
    const d = directo(f.transporte);
    expect(await d.enviar({ tipo: 'invoice', fullNumber: 'SETP1' })).toMatchObject({ codigo: 'CONFIG_FALTANTE' });
    expect(await d.enviar({ tipo: 'invoice', fullNumber: 'SETP', xmlFirmado: XML_FIRMADO })).toMatchObject({ codigo: 'CONFIG_FALTANTE' });
    expect(await d.enviarSetPruebas({ tipo: 'invoice', fullNumber: 'SETP1', xmlFirmado: XML_FIRMADO })).toMatchObject({
      codigo: 'CONFIG_FALTANTE',
    });
    expect(await d.consultar({})).toMatchObject({ codigo: 'CONFIG_FALTANTE' });
    expect(await d.rangos('')).toMatchObject({ codigo: 'CONFIG_FALTANTE', rangos: [] });
    expect(f.llamadas).toHaveLength(0);
  });

  it('timeout: vence el presupuesto → RED y aborta la señal, aunque el transporte la ignore', async () => {
    let senal: AbortSignal | undefined;
    const colgado: TransporteHttp = (_url, init) => {
      senal = init.signal;
      return new Promise(() => undefined);
    };
    const inicio = Date.now();
    const r = await directo(colgado, { presupuestoMs: 30 }).enviar({
      tipo: 'invoice',
      fullNumber: 'SETP1',
      xmlFirmado: XML_FIRMADO,
    });
    expect(r).toMatchObject({ ok: false, codigo: 'RED', origen: 'adapter' });
    expect(r.isValid).toBeUndefined();
    expect(senal?.aborted).toBe(true);
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it('presupuestoMs de la llamada gana si es menor que el configurado', async () => {
    const lento: TransporteHttp = () => new Promise(() => undefined);
    const inicio = Date.now();
    const r = await directo(lento, { presupuestoMs: 10_000 }).consultar({ cufe: 'c', presupuestoMs: 20 });
    expect(r).toMatchObject({ codigo: 'RED', origen: 'adapter' });
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it('presupuestoMs de la llamada mayor que el configurado no lo alarga', async () => {
    const lento: TransporteHttp = () => new Promise(() => undefined);
    const r = await directo(lento, { presupuestoMs: 20 }).consultar({ cufe: 'c', presupuestoMs: 60_000 });
    expect(r.codigo).toBe('RED');
  });

  it('signal del llamador: abortada antes no sale a la red; abortada durante corta con RED', async () => {
    const f = falso(200, respuestaDocumento('GetStatus', { isValid: 'true' }));
    const ya = new AbortController();
    ya.abort();
    expect(await directo(f.transporte).consultar({ cufe: 'c', signal: ya.signal })).toMatchObject({ codigo: 'RED' });
    expect(f.llamadas).toHaveLength(0);

    let interna: AbortSignal | undefined;
    const lento: TransporteHttp = (_u, init) => {
      interna = init.signal;
      return new Promise(() => undefined);
    };
    const externo = new AbortController();
    const p = directo(lento, { presupuestoMs: 10_000 }).enviar({
      tipo: 'invoice',
      fullNumber: 'SETP1',
      xmlFirmado: XML_FIRMADO,
      signal: externo.signal,
    });
    setTimeout(() => externo.abort(), 10);
    const r = await p;
    expect(r).toMatchObject({ codigo: 'RED', origen: 'adapter' });
    expect(r.isValid).toBeUndefined();
    expect(interna?.aborted).toBe(true);
  });

  it('presupuesto por operación', async () => {
    const lento: TransporteHttp = () => new Promise(() => undefined);
    const r = await directo(lento, { presupuestoMs: 10_000, presupuestosMs: { GetStatus: 20 } }).consultar({ cufe: 'c' });
    expect(r.codigo).toBe('RED');
  });

  it('error de red del transporte → RED sin filtrar el mensaje original', async () => {
    const roto: TransporteHttp = async () => {
      throw new Error(`ECONNRESET ${material.llavePem}`);
    };
    const r = await directo(roto).consultar({ cufe: 'c' });
    expect(r).toMatchObject({ ok: false, codigo: 'RED', origen: 'adapter', mensajes: ['No se pudo conectar con la DIAN'] });
  });

  it('cuerpo que no se puede leer → RED', async () => {
    const roto: TransporteHttp = async () => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(c) {
          c.error(new Error('corte'));
        },
      }),
    });
    expect(await directo(roto).consultar({ cufe: 'c' })).toMatchObject({ codigo: 'RED' });
  });

  it('Fault de certificado no autorizado → NO_RECIBIDO_DIAN', async () => {
    const f = falso(500, faultSoap('Sender', 'InvalidSecurity', 'Certificado no autorizado'));
    const r = await directo(f.transporte).enviar({ tipo: 'invoice', fullNumber: 'SETP1', xmlFirmado: XML_FIRMADO });
    expect(r).toMatchObject({ codigo: 'NO_RECIBIDO_DIAN' });
  });

  it('llave inservible → CONFIG_FALTANTE con mensaje fijo, sin la llave', async () => {
    const f = falso(200, '');
    const d = directo(f.transporte, { material: { llavePem: 'no-es-una-llave-secreta-xyz', certificadoB64: material.certificadoB64 } });
    const r = await d.consultar({ cufe: 'c' });
    expect(r.codigo).toBe('CONFIG_FALTANTE');
    expect(JSON.stringify(r)).not.toContain('no-es-una-llave-secreta-xyz');
    expect(f.llamadas).toHaveLength(0);
  });

  it('la llave no sale al serializar ni al inspeccionar el transmisor', () => {
    const d = directo(falso(200, '').transporte);
    const llave = material.llavePem.split('\n').slice(1, -2).join('').slice(0, 40);
    const vistas = [
      JSON.stringify(d),
      inspect(d, { showHidden: true, depth: 10, getters: true }),
      JSON.stringify(Object.assign({}, d)),
      Object.getOwnPropertyNames(d).join(','),
      String(d),
    ];
    for (const v of vistas) {
      expect(v).not.toContain(llave);
      expect(v).not.toContain('PRIVATE KEY');
      expect(v).not.toContain('soft-123');
    }
    expect(JSON.parse(JSON.stringify(d))).toEqual({ transmisor: 'DirectoDian', url: URL_DIAN_POR_AMBIENTE['2'] });
  });

  it('el transporte recibe redirect manual y todo 3xx es RED', async () => {
    for (const status of [301, 302, 307, 308]) {
      const f = falso(status, respuestaDocumento('GetStatus', { isValid: 'true' }));
      const r = await directo(f.transporte).consultar({ cufe: 'c' });
      expect(f.llamadas[0]!.init.redirect).toBe('manual');
      expect(r).toMatchObject({ ok: false, codigo: 'RED', origen: 'adapter' });
    }
  });

  it('Content-Length por encima del tope → RED sin leer el cuerpo', async () => {
    let leido = false;
    const t: TransporteHttp = async () => ({
      status: 200,
      headers: new Headers({ 'content-length': String(MAX_BYTES_RESPUESTA + 1) }),
      // highWaterMark 0: el stream no pide datos hasta que alguien lee.
      body: new ReadableStream<Uint8Array>(
        {
          pull(c) {
            leido = true;
            c.close();
          },
        },
        { highWaterMark: 0 },
      ),
    });
    expect(await directo(t).consultar({ cufe: 'c' })).toMatchObject({ codigo: 'RED' });
    expect(leido).toBe(false);
  });

  it('cuerpo en streaming: cuenta bytes y aborta al pasar el tope', async () => {
    let entregados = 0;
    let cancelado = false;
    let senal: AbortSignal | undefined;
    const trozo = new Uint8Array(1024 * 1024).fill(0x61);
    const t: TransporteHttp = async (_u, init) => {
      senal = init.signal;
      return {
        status: 200,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          pull(c) {
            entregados++;
            c.enqueue(trozo);
          },
          cancel() {
            cancelado = true;
          },
        }),
      };
    };
    const r = await directo(t).consultar({ cufe: 'c' });
    expect(r).toMatchObject({ codigo: 'RED', origen: 'adapter' });
    expect(cancelado).toBe(true);
    expect(senal?.aborted).toBe(true);
    // Corta en cuanto supera 5 MB: no sigue leyendo indefinidamente.
    expect(entregados).toBeLessThanOrEqual(8);
  });

  it('el tope cuenta bytes, no caracteres (multibyte)', async () => {
    // ~3 bytes por carácter: menos caracteres que el tope, más bytes.
    const grande = 'ñ€'.repeat(Math.ceil(MAX_BYTES_RESPUESTA / 4));
    expect(grande.length).toBeLessThan(MAX_BYTES_RESPUESTA);
    const conStream: TransporteHttp = async () => new Response(grande, { status: 200 });
    expect(await directo(conStream).consultar({ cufe: 'c' })).toMatchObject({ codigo: 'RED' });
  });

  it('lee una respuesta normal por streaming (Response real de fetch)', async () => {
    const t: TransporteHttp = async () =>
      new Response(respuestaDocumento('GetStatus', { isValid: 'true', cufe: 'cufe-9' }), { status: 200 });
    expect(await directo(t).consultar({ cufe: 'cufe-9' })).toMatchObject({ ok: true, isValid: true });
  });

  it('respuesta de otro CUFE → RED, nunca veredicto', async () => {
    const f = falso(200, respuestaDocumento('SendBillSync', { isValid: 'false', statusCode: '99', errores: ['x'], cufe: 'ajeno' }));
    const r = await directo(f.transporte).enviar({ tipo: 'invoice', fullNumber: 'SETP1', xmlFirmado: XML_FIRMADO, cufe: 'propio' });
    expect(r).toMatchObject({ codigo: 'RED' });
    expect(r.isValid).toBeUndefined();
  });

  it('tipoAmbiente solo con clave propia y de tipo string; NIT sin guion ni DV', async () => {
    const t = falso(200, '').transporte;
    for (const amb of ['toString', '__proto__', 'constructor', 2, '', null]) {
      expect(() => directo(t, { tipoAmbiente: amb as never })).toThrow(/Ambiente/);
    }
    expect(() => directo(t, { nit: '900123456-7' })).toThrow(/NIT/);
    expect(() => directo(t, { nit: '900 123 456 - 7' })).toThrow(/NIT/);
    expect(() => directo(t, { nit: 900123456 as never })).toThrow(/NIT/);
    expect(() => directo(t, { nitProveedor: '800111222-1' })).toThrow(/NIT/);
    expect(directo(t, { nit: '900.123.456' }).urlServicio).toBe(URL_DIAN_POR_AMBIENTE['2']);
    const f = falso(200, respuestaRangos());
    expect(await directo(f.transporte).rangos('900123456-7')).toMatchObject({ codigo: 'CONFIG_FALTANTE', rangos: [] });
    expect(f.llamadas).toHaveLength(0);
  });

  it('un valor con caracteres no permitidos en XML no sale a la red', async () => {
    const f = falso(200, '');
    const r = await directo(f.transporte).consultar({ cufe: 'abc\u0001' });
    expect(r).toMatchObject({ codigo: 'CONFIG_FALTANTE' });
    expect(f.llamadas).toHaveLength(0);
  });

  it('ninguna salida contiene secretos (llave, contraseña del .p12, clave técnica)', async () => {
    const llave = material.llavePem.split('\n').slice(1, -2).join('');
    const casos: Array<[number, string]> = [
      [200, respuestaDocumento('SendBillSync', { isValid: 'true' })],
      [200, respuestaDocumento('SendBillSync', { isValid: 'false', statusCode: '99', errores: ['Regla: X'] })],
      [500, faultSoap('Sender', 'InvalidSecurity', 'x')],
      [503, 'caído'],
      [200, respuestaRangos()],
    ];
    for (const [status, cuerpo] of casos) {
      const f = falso(status, cuerpo);
      const d = directo(f.transporte);
      const salidas = [
        await d.enviar({ tipo: 'invoice', fullNumber: 'SETP1', xmlFirmado: XML_FIRMADO }),
        await d.rangos('900123456'),
      ];
      for (const s of salidas) {
        assertContratoRespuesta(s);
        const texto = JSON.stringify(s);
        expect(texto).not.toContain(llave.slice(0, 40));
        expect(texto).not.toContain(PASSWORD);
        expect(texto).not.toContain(CLAVE_TECNICA_PRUEBA);
        expect(texto).not.toContain('PRIVATE KEY');
      }
      for (const { init } of f.llamadas) {
        expect(init.body).not.toContain('PRIVATE KEY');
        expect(init.body).not.toContain(llave.slice(0, 40));
        expect(init.body).not.toContain(PASSWORD);
      }
    }
  });
  it('sin cuerpo en streaming no hay respaldo text(): RED sin leer nada', async () => {
    // `text()` lee la respuesta entera antes de poder medirla: se descarta.
    let leido = false;
    const t: TransporteHttp = async () =>
      ({
        status: 200,
        text: async () => {
          leido = true;
          return respuestaDocumento('GetStatus', { isValid: 'true', cufe: 'c' });
        },
      }) as never;
    expect(await directo(t).consultar({ cufe: 'c' })).toMatchObject({ ok: false, codigo: 'RED', origen: 'adapter' });
    expect(leido).toBe(false);
    const nulo: TransporteHttp = async () => ({ status: 200, body: null });
    expect(await directo(nulo).consultar({ cufe: 'c' })).toMatchObject({ codigo: 'RED' });
  });

  it('presupuestoMs y presupuestosMs del constructor: entero finito > 0, si no lanza', () => {
    const t = falso(200, '').transporte;
    for (const malo of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8000', null, 2 ** 31]) {
      expect(() => directo(t, { presupuestoMs: malo as never })).toThrow(/presupuesto/i);
      expect(() => directo(t, { presupuestosMs: { GetStatus: malo as never } })).toThrow(/presupuesto/i);
    }
    expect(() => directo(t, { presupuestosMs: { Inventada: 100 } as never })).toThrow(/presupuesto/i);
    expect(() => directo(t, { presupuestosMs: null as never })).toThrow(/presupuesto/i);
    expect(directo(t, { presupuestoMs: 1, presupuestosMs: { GetStatus: 5_000 } })).toBeInstanceOf(DirectoDian);
  });

  it('un presupuesto de llamada agotado (0 o negativo) no sale a la red', async () => {
    for (const presupuestoMs of [0, -5]) {
      const f = falso(200, respuestaDocumento('GetStatus', { isValid: 'true', cufe: 'c' }));
      const r = await directo(f.transporte).consultar({ cufe: 'c', presupuestoMs });
      expect(r).toMatchObject({ ok: false, codigo: 'RED', origen: 'adapter' });
      expect(f.llamadas).toHaveLength(0);
    }
  });
});
