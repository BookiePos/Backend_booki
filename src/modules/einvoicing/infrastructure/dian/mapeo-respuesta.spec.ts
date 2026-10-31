import { describe, expect, it } from 'vitest';
import { esVeredictoDian, estadoTrasRespuesta } from '../../domain/estado-dian';
import { limpiarMensaje, mapearRespuestaDocumento, mapearRespuestaRangos } from './mapeo-respuesta';
import {
  CLAVE_TECNICA_PRUEBA,
  faultSoap,
  respuestaDocumento,
  respuestaRangos,
  respuestaStatusZip,
  respuestaTestSet,
  sobre,
} from './respuestas-dian.test';

describe('mapeo fail-closed de la respuesta DIAN', () => {
  it('IsValid=true → aceptado, origen dian, con CUFE', () => {
    const r = mapearRespuestaDocumento(
      'SendBillSync',
      200,
      respuestaDocumento('SendBillSync', { isValid: 'true', statusCode: '00', descripcion: 'Procesado Correctamente.', cufe: 'abc' }),
    );
    expect(r).toMatchObject({ ok: true, isValid: true, origen: 'dian', codigo: '00', cufe: 'abc' });
    expect(estadoTrasRespuesta('sent', r)).toBe('accepted');
  });

  it('IsValid=false con errores → rechazo con los mensajes de ErrorMessage', () => {
    const r = mapearRespuestaDocumento(
      'SendBillSync',
      200,
      respuestaDocumento('SendBillSync', {
        isValid: 'false',
        statusCode: '99',
        descripcion: 'Validación contiene errores en campos mandatorios.',
        errores: ['Regla: FAD06, Rechazo: Valor del CUFE no está calculado correctamente.', 'Regla: FAJ43b, Rechazo: Nombre no coincide.'],
      }),
    );
    expect(r).toMatchObject({ ok: false, isValid: false, origen: 'dian', codigo: '99' });
    expect(r.mensajes).toContain('Regla: FAD06, Rechazo: Valor del CUFE no está calculado correctamente.');
    expect(r.mensajes).toHaveLength(3);
    expect(esVeredictoDian(r)).toBe(true);
    expect(estadoTrasRespuesta('sent', r)).toBe('rejected');
  });

  it('regla 90 (documento procesado anteriormente) → YA_PROCESADO_DIAN, sin veredicto', () => {
    const r = mapearRespuestaDocumento(
      'SendBillSync',
      200,
      respuestaDocumento('SendBillSync', {
        isValid: 'false',
        statusCode: '99',
        errores: ['Regla: 90, Rechazo: Documento procesado anteriormente.'],
      }),
    );
    expect(r).toMatchObject({ ok: false, codigo: 'YA_PROCESADO_DIAN', origen: 'dian' });
    expect(r.isValid).toBeUndefined();
    expect(estadoTrasRespuesta('sent', r)).toBe('sent');
  });

  it('IsValid=false sin errores ni código de errores → PENDIENTE, nunca rechazo', () => {
    const r = mapearRespuestaDocumento(
      'GetStatus',
      200,
      respuestaDocumento('GetStatus', { isValid: 'false', statusCode: '2', descripcion: 'Algo raro' }),
    );
    expect(r).toMatchObject({ ok: false, codigo: 'PENDIENTE_DIAN' });
    expect(r.isValid).toBeUndefined();
  });

  it('GetStatus de un documento que la DIAN no encuentra → NO_RECIBIDO_DIAN', () => {
    const r = mapearRespuestaDocumento(
      'GetStatus',
      200,
      respuestaDocumento('GetStatus', { isValid: 'false', statusCode: '66', descripcion: 'NSU no encontrado.' }),
    );
    expect(r).toMatchObject({ ok: false, codigo: 'NO_RECIBIDO_DIAN', origen: 'dian' });
    expect(r.isValid).toBeUndefined();
  });

  it('GetStatusZip en proceso de validación → PENDIENTE_DIAN', () => {
    const r = mapearRespuestaDocumento(
      'GetStatusZip',
      200,
      respuestaStatusZip([{ isValid: 'false', statusCode: '98', descripcion: 'Batch en proceso de validación.' }]),
    );
    expect(r).toMatchObject({ ok: false, codigo: 'PENDIENTE_DIAN' });
    expect(r.isValid).toBeUndefined();
    expect(mapearRespuestaDocumento('GetStatusZip', 200, respuestaStatusZip([]))).toMatchObject({ codigo: 'PENDIENTE_DIAN' });
  });

  it('GetStatusZip ya validado → veredicto del primer DianResponse', () => {
    const r = mapearRespuestaDocumento(
      'GetStatusZip',
      200,
      respuestaStatusZip([{ isValid: 'true', statusCode: '00', descripcion: 'Procesado Correctamente.' }]),
    );
    expect(r).toMatchObject({ ok: true, isValid: true });
  });

  it('SendTestSetAsync con ZipKey → PENDIENTE_DIAN con zipKey y trackId', () => {
    const r = mapearRespuestaDocumento('SendTestSetAsync', 200, respuestaTestSet('zip-key-123'));
    expect(r).toMatchObject({ ok: false, codigo: 'PENDIENTE_DIAN', origen: 'dian', zipKey: 'zip-key-123', trackId: 'zip-key-123' });
    expect(r.isValid).toBeUndefined();
  });

  it('SendTestSetAsync con errores de carga → NO_RECIBIDO_DIAN', () => {
    const r = mapearRespuestaDocumento('SendTestSetAsync', 200, respuestaTestSet(undefined, ['El TestSetId no es válido']));
    expect(r).toMatchObject({ ok: false, codigo: 'NO_RECIBIDO_DIAN' });
    expect(r.mensajes).toEqual(['El TestSetId no es válido']);
    expect(mapearRespuestaDocumento('SendTestSetAsync', 200, respuestaTestSet())).toMatchObject({ codigo: 'NO_RECIBIDO_DIAN' });
  });

  it('SOAP Fault del emisor (Sender, incluso con HTTP 500) → NO_RECIBIDO_DIAN', () => {
    const cuerpo = faultSoap('Sender', 'InvalidSecurity', 'An error occurred when verifying security for the message.');
    for (const status of [400, 500]) {
      const r = mapearRespuestaDocumento('SendBillSync', status, cuerpo);
      expect(r).toMatchObject({ ok: false, codigo: 'NO_RECIBIDO_DIAN', origen: 'dian' });
      expect(r.isValid).toBeUndefined();
      expect(r.mensajes).toEqual(['An error occurred when verifying security for the message.']);
    }
  });

  it('Fault del servidor (Receiver) → RED', () => {
    const r = mapearRespuestaDocumento('SendBillSync', 500, faultSoap('Receiver', 'InternalServiceFault', 'Error interno'));
    expect(r).toMatchObject({ ok: false, codigo: 'RED', origen: 'adapter' });
  });

  it('HTTP 5xx sin Fault, 4xx sin Fault y cuerpo ilegible', () => {
    expect(mapearRespuestaDocumento('SendBillSync', 503, '<html>Service Unavailable</html>')).toMatchObject({ codigo: 'RED', origen: 'adapter' });
    expect(mapearRespuestaDocumento('SendBillSync', 404, 'Not Found')).toMatchObject({ codigo: 'NO_RECIBIDO_DIAN', origen: 'adapter' });
    expect(mapearRespuestaDocumento('SendBillSync', 200, 'esto no es xml <')).toMatchObject({ codigo: 'RED' });
    expect(mapearRespuestaDocumento('SendBillSync', 200, '')).toMatchObject({ codigo: 'RED' });
    expect(mapearRespuestaDocumento('SendBillSync', 200, sobre('<Otra/>'))).toMatchObject({ codigo: 'RED' });
    // Respuesta de otra operación: no se acepta como esta.
    expect(
      mapearRespuestaDocumento('SendBillSync', 200, respuestaDocumento('GetStatus', { isValid: 'true' })),
    ).toMatchObject({ codigo: 'RED' });
    // Sin IsValid: no hay veredicto.
    expect(mapearRespuestaDocumento('SendBillSync', 200, respuestaDocumento('SendBillSync', {}))).toMatchObject({ codigo: 'RED' });
  });

  it('rechaza DOCTYPE y entidades (XXE)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${respuestaDocumento('SendBillSync', { isValid: 'true' })}`;
    const r = mapearRespuestaDocumento('SendBillSync', 200, xxe);
    expect(r).toMatchObject({ ok: false, codigo: 'RED' });
  });

  it('limpia los mensajes: sin bloques base64 largos ni saltos', () => {
    expect(limpiarMensaje(`Error\n en ${'A'.repeat(200)} fin`)).toBe('Error en [omitido] fin');
    expect(limpiarMensaje('ab '.repeat(300))).toHaveLength(501);
  });
});

describe('mapeo de GetNumberingRange', () => {
  it('lee prefijo, desde, hasta, resolución y la clave técnica sin exponerla', () => {
    const r = mapearRespuestaRangos(200, respuestaRangos('100', 2));
    expect(r).toMatchObject({ ok: true, isValid: true, origen: 'dian', codigo: '100' });
    expect(r.rangos).toHaveLength(2);
    expect(r.rangos[0]).toMatchObject({ prefijo: 'SETP', desde: 990000000, hasta: 995000000, resolucion: '18760000000' });
    expect(r.rangos[0]!.claveTecnica).toBe(CLAVE_TECNICA_PRUEBA);
    // No enumerable: ni JSON, ni spread, ni inspección la muestran.
    expect(JSON.stringify(r)).not.toContain(CLAVE_TECNICA_PRUEBA);
    expect(JSON.stringify({ ...r.rangos[0] })).not.toContain(CLAVE_TECNICA_PRUEBA);
    expect(Object.keys(r.rangos[0]!)).not.toContain('claveTecnica');
  });

  it('OperationCode distinto de 100 → sin rangos, con la descripción', () => {
    const r = mapearRespuestaRangos(200, respuestaRangos('301', 0));
    expect(r).toMatchObject({ ok: false, isValid: false, codigo: '301', rangos: [] });
    expect(r.mensajes).toEqual(['No se encontró registro de software.']);
  });

  it('red y Fault → sin rangos', () => {
    expect(mapearRespuestaRangos(502, 'Bad Gateway')).toMatchObject({ codigo: 'RED', rangos: [] });
    expect(mapearRespuestaRangos(500, faultSoap('Sender', 'FailedAuthentication', 'No autorizado'))).toMatchObject({
      codigo: 'NO_RECIBIDO_DIAN',
      rangos: [],
    });
    const malo = respuestaRangos().replace('<c:FromNumber>990000000', '<c:FromNumber>abc');
    expect(mapearRespuestaRangos(200, malo)).toMatchObject({ codigo: 'RED', rangos: [] });
  });
});
