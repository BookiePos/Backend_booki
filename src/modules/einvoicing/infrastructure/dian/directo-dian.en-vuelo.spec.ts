import { beforeAll, describe, expect, it } from 'vitest';
import { CODIGOS_SIN_VEREDICTO, esVeredictoDian, estadoTrasRespuesta, quedaEnVuelo } from '../../domain/estado-dian';
import { p12DePrueba } from '../../domain/p12-de-prueba.test';
import { assertContratoRespuesta, type RespuestaDian } from '../../domain/transmisor-dian';
import { abrirP12, type MaterialFirma } from '../firma/material-p12';
import { crearDirectoDian, type DirectoDian, type TransporteHttp } from './directo-dian';
import { faultSoap, respuestaDocumento, respuestaStatusZip, sobre } from './respuestas-dian.test';

/**
 * Fase 11 · cliente SOAP con transporte falso, de punta a punta con la máquina
 * de estados: ninguna falla de red, de HTTP o de lectura puede terminar en
 * `rejected` (ni en `accepted`). Lo que no es un veredicto legible de la DIAN
 * sobre ESTE documento deja el documento en vuelo, para reconsultar con el
 * mismo número. Un `rejected` por un timeout haría que el negocio «corrigiera»
 * y reenviara una venta que la DIAN quizá ya aceptó.
 *
 * Cada falla se prueba en las tres operaciones de documento (SendBillSync,
 * SendNominaSync y GetStatus) y al final hay dos controles con veredicto real,
 * para que la tabla no pase por estar vacía.
 */

const PASSWORD = 'clave-de-prueba';
const CUFE = 'cufe-de-prueba-123';
const XML_FIRMADO =
  '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">firmado</Invoice>';

let material: MaterialFirma;
beforeAll(() => {
  material = abrirP12(p12DePrueba({ password: PASSWORD }), PASSWORD);
});

type Op = 'SendBillSync' | 'SendNominaSync' | 'GetStatus';

function directo(transporte: TransporteHttp, presupuestoMs?: number): DirectoDian {
  return crearDirectoDian({
    material,
    tipoAmbiente: '1',
    softwareId: 'soft-123',
    nit: '900123456',
    transporte,
    reloj: () => new Date('2026-10-30T15:00:00Z'),
    ...(presupuestoMs ? { presupuestoMs } : {}),
  });
}

const LLAMADAS: Record<Op, (d: DirectoDian) => Promise<RespuestaDian>> = {
  SendBillSync: (d) => d.enviar({ tipo: 'invoice', fullNumber: 'SETP990000001', cufe: CUFE, xmlFirmado: XML_FIRMADO }),
  SendNominaSync: (d) => d.enviar({ tipo: 'payroll', fullNumber: 'NE1', cufe: CUFE, xmlFirmado: XML_FIRMADO }),
  GetStatus: (d) => d.consultar({ cufe: CUFE }),
};
const OPERACIONES = Object.keys(LLAMADAS) as Op[];

const http =
  (status: number, cuerpo: (op: Op) => string | null): ((op: Op) => TransporteHttp) =>
  (op) =>
  async () =>
    new Response(cuerpo(op), { status });

const RECHAZO = (op: Op, extra: Parameters<typeof respuestaDocumento>[1] = {}): string =>
  respuestaDocumento(op, {
    isValid: 'false',
    statusCode: '99',
    descripcion: 'Documento con errores en campos mandatorios.',
    errores: ['Regla: FAD06, Rechazo: Valor del CUFE no está calculado correctamente'],
    cufe: CUFE,
    ...extra,
  });
const ACEPTACION = (op: Op, extra: Parameters<typeof respuestaDocumento>[1] = {}): string =>
  respuestaDocumento(op, { isValid: 'true', statusCode: '00', descripcion: 'Procesado Correctamente.', cufe: CUFE, ...extra });
const conIsValid = (op: Op, valor: string): string =>
  RECHAZO(op).replace('<b:IsValid>false</b:IsValid>', `<b:IsValid>${valor}</b:IsValid>`);

const HTML = '<html><head><title>503 Service Temporarily Unavailable</title></head><body>mantenimiento</body></html>';

/** Falla → transporte por operación (+ presupuesto, para las que cuelgan). */
const FALLAS: Record<string, { transporte: (op: Op) => TransporteHttp; presupuestoMs?: number }> = {
  'el transporte lanza (ECONNRESET)': {
    transporte: () => async () => {
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    },
  },
  'el transporte lanza (TypeError: fetch failed, DNS o TLS)': {
    transporte: () => async () => {
      throw new TypeError('fetch failed');
    },
  },
  'el transporte nunca responde (timeout)': {
    transporte: () => () => new Promise(() => undefined),
    presupuestoMs: 25,
  },
  'llegan las cabeceras y el cuerpo se cuelga (timeout a mitad de respuesta)': {
    transporte: () => async () => ({ status: 200, body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }) }),
    presupuestoMs: 25,
  },
  'el cuerpo se corta a mitad de lectura': {
    transporte: (op) => async () => {
      const bytes = new TextEncoder().encode(RECHAZO(op));
      let enviado = false;
      return {
        status: 200,
        body: new ReadableStream<Uint8Array>({
          pull(c) {
            if (!enviado) {
              enviado = true;
              c.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
            } else {
              c.error(new Error('socket hang up'));
            }
          },
        }),
      };
    },
  },
  'HTTP 200 con un rechazo TRUNCADO (XML mal formado)': {
    transporte: http(200, (op) => RECHAZO(op).slice(0, RECHAZO(op).indexOf('</b:IsValid>') + 12)),
  },
  'HTTP 200 con bytes que no son UTF-8': {
    transporte: () => async () => new Response(new Uint8Array([0x3c, 0x73, 0xff, 0xfe, 0x3e]), { status: 200 }),
  },
  'HTTP 200 con HTML (página de mantenimiento o WAF)': { transporte: http(200, () => HTML) },
  'HTTP 200 con el cuerpo vacío': { transporte: http(200, () => '') },
  'HTTP 204 sin cuerpo': { transporte: http(204, () => null) },
  'HTTP 301 (redirección)': { transporte: http(301, () => HTML) },
  'HTTP 401 con HTML': { transporte: http(401, () => HTML) },
  'HTTP 403 con HTML': { transporte: http(403, () => HTML) },
  'HTTP 404 con HTML': { transporte: http(404, () => HTML) },
  'HTTP 429 (límite de peticiones)': { transporte: http(429, () => 'Too Many Requests') },
  'HTTP 500 con HTML': { transporte: http(500, () => HTML) },
  'HTTP 502 del balanceador': { transporte: http(502, () => HTML) },
  'HTTP 503 con el cuerpo vacío': { transporte: http(503, () => '') },
  'HTTP 504 (timeout de la pasarela)': { transporte: http(504, () => 'Gateway Timeout') },
  'HTTP 500 con Fault del servidor (Receiver)': {
    transporte: http(500, () => faultSoap('Receiver', 'InternalServiceFault', 'Error interno del servicio')),
  },
  'HTTP 500 con Fault del emisor (certificado no autorizado)': {
    transporte: http(500, () => faultSoap('Sender', 'InvalidSecurity', 'Certificado no autorizado')),
  },
  'HTTP 200 con un Fault': {
    transporte: http(200, () => faultSoap('Receiver', 'InternalServiceFault', 'Error interno del servicio')),
  },
  // La forma del cuerpo es la de un rechazo, pero el estado HTTP dice que el servicio falló.
  'HTTP 500 con cuerpo de rechazo (IsValid=false y errores)': { transporte: http(500, (op) => RECHAZO(op)) },
  'HTTP 400 con cuerpo de rechazo (IsValid=false y errores)': { transporte: http(400, (op) => RECHAZO(op)) },
  'HTTP 500 con cuerpo de aceptación (IsValid=true)': { transporte: http(500, (op) => ACEPTACION(op)) },
  'HTTP 200 con la respuesta de OTRA operación': {
    transporte: http(200, () => respuestaStatusZip([{ isValid: 'false', statusCode: '99', errores: ['FAD06'], cufe: CUFE }])),
  },
  'HTTP 200 con un sobre sin resultado': { transporte: http(200, () => sobre('')) },
  'HTTP 200 sin IsValid': { transporte: http(200, (op) => RECHAZO(op, { isValid: undefined })) },
  'HTTP 200 con IsValid vacío': { transporte: http(200, (op) => conIsValid(op, '')) },
  'HTTP 200 con IsValid «0»': { transporte: http(200, (op) => conIsValid(op, '0')) },
  'HTTP 200 con IsValid «no»': { transporte: http(200, (op) => conIsValid(op, 'no')) },
  'HTTP 200 con IsValid «falso»': { transporte: http(200, (op) => conIsValid(op, 'falso')) },
  'HTTP 200 con IsValid nulo (i:nil)': {
    transporte: http(200, (op) => RECHAZO(op).replace('<b:IsValid>false</b:IsValid>', '<b:IsValid i:nil="true"/>')),
  },
  'HTTP 200 con el rechazo de OTRO documento': { transporte: http(200, (op) => RECHAZO(op, { cufe: 'cufe-de-otra-venta' })) },
  'HTTP 200 con la aceptación de OTRO documento': {
    transporte: http(200, (op) => ACEPTACION(op, { cufe: 'cufe-de-otra-venta' })),
  },
  'HTTP 200 con una aceptación que no dice de qué documento': { transporte: http(200, (op) => ACEPTACION(op, { cufe: null })) },
  'HTTP 200 IsValid=false sin errores ni código de errores (aún valida)': {
    transporte: http(200, (op) => RECHAZO(op, { statusCode: '00', descripcion: '', errores: [] })),
  },
  'HTTP 200 regla 90 (documento procesado anteriormente)': {
    transporte: http(200, (op) =>
      RECHAZO(op, { errores: ['Regla: 90, Rechazo: Documento procesado anteriormente.'] }),
    ),
  },
};

/** Lo que se exige de toda respuesta que no es veredicto. */
function esperarEnVuelo(r: RespuestaDian): void {
  expect(() => assertContratoRespuesta(r)).not.toThrow();
  expect(r.ok).toBe(false);
  expect(r.isValid).toBeUndefined();
  expect(CODIGOS_SIN_VEREDICTO as readonly string[]).toContain(r.codigo);
  expect(esVeredictoDian(r)).toBe(false);
  expect(quedaEnVuelo(r)).toBe(true);
  // Ya salió a la red: el enviado sigue enviado y el firmado pasa a enviado. Nunca rejected ni accepted.
  expect(estadoTrasRespuesta('sent', r)).toBe('sent');
  expect(estadoTrasRespuesta('signed', r)).toBe('sent');
  expect(estadoTrasRespuesta('contingency', r)).toBe('contingency');
}

describe('DirectoDian + máquina de estados: una falla del SOAP nunca es veredicto', () => {
  const casos = Object.entries(FALLAS).flatMap(([nombre, f]) => OPERACIONES.map((op) => [nombre, op, f] as const));

  it.each(casos)('%s · %s → en vuelo', async (_nombre, op, falla) => {
    const r = await LLAMADAS[op](directo(falla.transporte(op), falla.presupuestoMs));
    esperarEnVuelo(r);
  });

  it('GetStatusZip: un lote con varias respuestas y sin CUFE que diga cuál es la del documento → en vuelo', async () => {
    const lote = respuestaStatusZip([
      { isValid: 'false', statusCode: '99', errores: ['FAD06'], cufe: 'cufe-a' },
      { isValid: 'true', statusCode: '00', cufe: 'cufe-b' },
    ]);
    const r = await directo(async () => new Response(lote, { status: 200 })).consultar({ trackId: 'zip-1' });
    esperarEnVuelo(r);
  });

  it('GetStatusZip: el lote trae el rechazo de otro documento y no el consultado → en vuelo', async () => {
    const lote = respuestaStatusZip([
      { isValid: 'false', statusCode: '99', errores: ['FAD06'], cufe: 'cufe-a' },
      { isValid: 'false', statusCode: '99', errores: ['FAD06'], cufe: 'cufe-b' },
    ]);
    const r = await directo(async () => new Response(lote, { status: 200 })).consultar({ trackId: 'zip-1', cufe: CUFE });
    esperarEnVuelo(r);
  });

  it.each(OPERACIONES)('control · %s: un rechazo legible de la DIAN sobre este documento SÍ es rejected', async (op) => {
    const r = await LLAMADAS[op](directo(async () => new Response(RECHAZO(op), { status: 200 })));
    expect(r).toMatchObject({ ok: false, isValid: false, origen: 'dian', codigo: '99', cufe: CUFE });
    expect(quedaEnVuelo(r)).toBe(false);
    expect(estadoTrasRespuesta('sent', r)).toBe('rejected');
  });

  it.each(OPERACIONES)('control · %s: una aceptación legible de la DIAN sobre este documento SÍ es accepted', async (op) => {
    const r = await LLAMADAS[op](directo(async () => new Response(ACEPTACION(op), { status: 200 })));
    expect(r).toMatchObject({ ok: true, isValid: true, origen: 'dian', cufe: CUFE });
    expect(estadoTrasRespuesta('sent', r)).toBe('accepted');
  });
});
