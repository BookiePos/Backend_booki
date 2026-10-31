import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { traeDoctype } from '../../domain/firma/revision-xml';
import {
  assertContratoRespuesta,
  type RangoNumeracionDian,
  type RespuestaDian,
  type RespuestaRangosDian,
} from '../../domain/transmisor-dian';
import {
  MAX_BYTES_RESPUESTA,
  OPERACION_RANGOS_OK,
  PATRON_EN_PROCESO,
  PATRON_YA_PROCESADO,
  STATUS_CON_ERRORES,
  STATUS_NO_ENCONTRADO,
  type OperacionDian,
} from './dian.constants';

/**
 * Traduce la respuesta HTTP del WCF de la DIAN a `RespuestaDian`, fail-closed:
 * solo `IsValid=true` acepta y solo `IsValid=false` con errores rechaza. Todo lo
 * demás (red, 5xx, cuerpo ilegible, Fault, set en validación, reenvío) queda sin
 * veredicto para que el documento no se mueva a `accepted`/`rejected` a ciegas.
 */

type Nodo = Record<string, unknown>;

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: true,
  isArray: (nombre) =>
    ['string', 'DianResponse', 'NumberRangeResponse', 'XmlParamsResponseTrackId', 'Text'].includes(nombre),
});

/** Mensajes: sin saltos, cortos y sin bloques base64 largos (podrían ser el XML o un certificado). */
const MAX_MENSAJES = 50;
const MAX_LARGO_MENSAJE = 500;
export function limpiarMensaje(m: string): string {
  const limpio = m
    .replace(/[A-Za-z0-9+/=]{100,}/g, '[omitido]')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > MAX_LARGO_MENSAJE ? `${limpio.slice(0, MAX_LARGO_MENSAJE)}…` : limpio;
}

function limpiarMensajes(ms: string[]): string[] {
  return ms.map(limpiarMensaje).filter(Boolean).slice(0, MAX_MENSAJES);
}

export function respuestaRed(mensaje: string): RespuestaDian {
  return cerrar({ ok: false, codigo: 'RED', origen: 'adapter', mensajes: [mensaje] });
}

function cerrar<T extends RespuestaDian>(r: T): T {
  r.mensajes = limpiarMensajes(r.mensajes);
  assertContratoRespuesta(r);
  return r;
}

function texto(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v === 'object' && '#text' in v) return texto((v as Nodo)['#text']);
  return undefined;
}

function nodo(v: unknown): Nodo | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Nodo) : undefined;
}

function lista(v: unknown): unknown[] {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

type Parseo =
  | { tipo: 'cuerpo'; resultado: Nodo }
  | { tipo: 'fault'; emisor: boolean; mensajes: string[] }
  | { tipo: 'ilegible' };

/** Parsea el sobre y devuelve el `<OperacionResult>` o el Fault. */
export function parsearSobre(cuerpo: string, op: OperacionDian): Parseo {
  if (!cuerpo || Buffer.byteLength(cuerpo, 'utf8') > MAX_BYTES_RESPUESTA) return { tipo: 'ilegible' };
  // Nada de DTD ni entidades: la respuesta viene de la red.
  if (traeDoctype(cuerpo) || /<!ENTITY/i.test(cuerpo)) return { tipo: 'ilegible' };
  if (XMLValidator.validate(cuerpo) !== true) return { tipo: 'ilegible' };
  let raiz: Nodo;
  try {
    raiz = parser.parse(cuerpo) as Nodo;
  } catch {
    return { tipo: 'ilegible' };
  }
  const body = nodo(nodo(raiz.Envelope)?.Body);
  if (!body) return { tipo: 'ilegible' };

  const fault = nodo(body.Fault);
  if (fault) return leerFault(fault);

  const respuesta = nodo(body[`${op}Response`]);
  const crudo = respuesta?.[`${op}Result`];
  // `<GetStatusZipResult/>` vacío llega como cadena vacía: es un resultado sin hijos.
  const resultado = crudo === '' ? {} : nodo(crudo);
  if (!resultado) return { tipo: 'ilegible' };
  return { tipo: 'cuerpo', resultado };
}

/** SOAP 1.2 (Code/Value, Reason/Text) y, por si acaso, 1.1 (faultcode/faultstring). */
function leerFault(f: Nodo): Parseo {
  const codigo = texto(nodo(f.Code)?.Value) ?? texto(f.faultcode) ?? '';
  const razones = lista(nodo(f.Reason)?.Text)
    .map(texto)
    .filter((t): t is string => Boolean(t));
  const fs = texto(f.faultstring);
  if (fs) razones.push(fs);
  // Sender/Client = el problema es del mensaje (certificado, firma, formato).
  const emisor = /(Sender|Client)$/i.test(codigo);
  return { tipo: 'fault', emisor, mensajes: razones.length ? razones : ['La DIAN devolvió un SOAP Fault'] };
}

/** Respuesta HTTP → RespuestaDian, para las operaciones de documento. */
export function mapearRespuestaDocumento(
  op: Exclude<OperacionDian, 'GetNumberingRange'>,
  status: number,
  cuerpo: string,
): RespuestaDian {
  const p = parsearSobre(cuerpo, op);
  const previo = previoAlCuerpo(p, status);
  if (previo) return previo;
  const resultado = (p as Extract<Parseo, { tipo: 'cuerpo' }>).resultado;

  if (op === 'SendTestSetAsync') return mapearAsincrono(resultado);
  if (op === 'GetStatusZip') {
    const primera = nodo(lista(resultado.DianResponse)[0]);
    // Lote aún sin respuestas: sigue en validación.
    if (!primera) return cerrar({ ok: false, codigo: 'PENDIENTE_DIAN', origen: 'dian', mensajes: ['La DIAN aún valida el lote'] });
    return mapearDianResponse(primera, op);
  }
  return mapearDianResponse(resultado, op);
}

/** Red/HTTP/Fault/ilegible, comunes a todas las operaciones. `null` = hay cuerpo que leer. */
function previoAlCuerpo(p: Parseo, status: number): RespuestaDian | null {
  if (p.tipo === 'fault') {
    if (p.emisor) {
      return cerrar({ ok: false, codigo: 'NO_RECIBIDO_DIAN', origen: 'dian', mensajes: p.mensajes });
    }
    return respuestaRed('La DIAN respondió con un error de servidor');
  }
  if (status >= 500) return respuestaRed(`La DIAN respondió HTTP ${status}`);
  if (status >= 400) {
    return cerrar({
      ok: false,
      codigo: 'NO_RECIBIDO_DIAN',
      origen: 'adapter',
      mensajes: [`La DIAN no recibió el mensaje (HTTP ${status})`],
    });
  }
  if (p.tipo === 'ilegible' || status < 200 || status >= 300) {
    return respuestaRed('La respuesta de la DIAN no se pudo leer');
  }
  return null;
}

function erroresDe(r: Nodo): string[] {
  return lista(nodo(r.ErrorMessage)?.string)
    .map(texto)
    .filter((t): t is string => Boolean(t));
}

/** Un `DianResponse` (SendBillSync, GetStatus, cada ítem de GetStatusZip). */
function mapearDianResponse(r: Nodo, op: OperacionDian): RespuestaDian {
  const isValid = texto(r.IsValid)?.toLowerCase();
  const statusCode = texto(r.StatusCode);
  const descripcion = texto(r.StatusDescription) ?? '';
  const errores = erroresDe(r);
  const cufe = texto(r.XmlDocumentKey) || undefined;
  const base = { origen: 'dian' as const, ...(cufe ? { cufe } : {}) };
  const mensajes = [descripcion, ...errores].filter(Boolean);

  if (isValid === 'true') {
    return cerrar({ ...base, ok: true, isValid: true, codigo: statusCode, mensajes });
  }
  if (isValid !== 'false') return respuestaRed('La respuesta de la DIAN no trae IsValid');

  if (errores.some((e) => PATRON_YA_PROCESADO.test(e)) || PATRON_YA_PROCESADO.test(descripcion)) {
    return cerrar({ ...base, ok: false, codigo: 'YA_PROCESADO_DIAN', mensajes });
  }
  if (PATRON_EN_PROCESO.test(descripcion) && errores.length === 0) {
    return cerrar({ ...base, ok: false, codigo: 'PENDIENTE_DIAN', mensajes });
  }
  if (op === 'GetStatus' && statusCode && (STATUS_NO_ENCONTRADO as readonly string[]).includes(statusCode)) {
    return cerrar({ ...base, ok: false, codigo: 'NO_RECIBIDO_DIAN', mensajes });
  }
  // Rechazo solo con evidencia: errores listados o el código de «con errores».
  if (errores.length > 0 || statusCode === STATUS_CON_ERRORES) {
    return cerrar({ ...base, ok: false, isValid: false, codigo: statusCode, mensajes });
  }
  return cerrar({ ...base, ok: false, codigo: 'PENDIENTE_DIAN', mensajes });
}

/** SendTestSetAsync: solo devuelve ZipKey (o la lista de errores de carga). */
function mapearAsincrono(r: Nodo): RespuestaDian {
  const zipKey = texto(r.ZipKey) || undefined;
  const errores = lista(nodo(r.ErrorMessageList)?.XmlParamsResponseTrackId)
    .map((e) => texto(nodo(e)?.ProcessedMessage))
    .filter((t): t is string => Boolean(t));
  if (errores.length > 0 || !zipKey) {
    return cerrar({
      ok: false,
      codigo: 'NO_RECIBIDO_DIAN',
      origen: 'dian',
      mensajes: errores.length ? errores : ['La DIAN no devolvió ZipKey'],
      ...(zipKey ? { zipKey, trackId: zipKey } : {}),
    });
  }
  return cerrar({
    ok: false,
    codigo: 'PENDIENTE_DIAN',
    origen: 'dian',
    mensajes: ['Set de pruebas recibido; la DIAN lo valida de forma asíncrona'],
    zipKey,
    trackId: zipKey,
  });
}

/**
 * La clave técnica va como propiedad NO enumerable: se lee con
 * `rango.claveTecnica`, pero `JSON.stringify`, `console.log` y un spread no la
 * copian, así que no llega a un log por accidente.
 */
function conClaveOculta(r: Omit<RangoNumeracionDian, 'claveTecnica'>, clave?: string): RangoNumeracionDian {
  if (clave) Object.defineProperty(r, 'claveTecnica', { value: clave, enumerable: false });
  return r;
}

function entero(v: unknown): number | undefined {
  const t = texto(v);
  if (!t || !/^\d{1,15}$/.test(t)) return undefined;
  return Number(t);
}

/** GetNumberingRange → RespuestaRangosDian. */
export function mapearRespuestaRangos(status: number, cuerpo: string): RespuestaRangosDian {
  const p = parsearSobre(cuerpo, 'GetNumberingRange');
  const previo = previoAlCuerpo(p, status);
  if (previo) return { ...previo, rangos: [] };
  const r = (p as Extract<Parseo, { tipo: 'cuerpo' }>).resultado;

  const codigo = texto(r.OperationCode);
  const descripcion = texto(r.OperationDescription) ?? '';
  if (!codigo) return { ...respuestaRed('La respuesta de rangos no trae OperationCode'), rangos: [] };
  if (codigo !== OPERACION_RANGOS_OK) {
    return cerrar({ ok: false, isValid: false, codigo, origen: 'dian', mensajes: [descripcion], rangos: [] });
  }

  const rangos: RangoNumeracionDian[] = [];
  for (const item of lista(nodo(r.ResponseList)?.NumberRangeResponse)) {
    const n = nodo(item);
    const desde = entero(n?.FromNumber);
    const hasta = entero(n?.ToNumber);
    if (!n || desde === undefined || hasta === undefined || hasta < desde) {
      return { ...respuestaRed('Un rango de numeración de la DIAN no se pudo leer'), rangos: [] };
    }
    const prefijo = texto(n.Prefix) || undefined;
    const resolucion = texto(n.ResolutionNumber) || undefined;
    rangos.push(
      conClaveOculta(
        { desde, hasta, ...(prefijo ? { prefijo } : {}), ...(resolucion ? { resolucion } : {}) },
        texto(n.TechnicalKey) || undefined,
      ),
    );
  }
  return cerrar({ ok: true, isValid: true, codigo, origen: 'dian', mensajes: [descripcion], rangos });
}
