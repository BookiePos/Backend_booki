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
  NS_DIAN_RESPONSE,
  OPERACION_RANGOS_OK,
  PATRON_EN_PROCESO,
  PATRON_NO_ENCONTRADO,
  PATRON_YA_PROCESADO,
  STATUS_CON_ERRORES,
  NS_SOAP12,
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

/** Lo que se envió o consultó, para comprobar que la respuesta habla del mismo documento. */
export interface EsperadoDian {
  cufe?: string;
}

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

/** Segunda lectura, con prefijos, solo para revisar la raíz y su namespace. */
const parserRaiz = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/** `Envelope` debe ser la única raíz y estar en el namespace de SOAP 1.2. */
function raizEsSobreSoap12(cuerpo: string): boolean {
  let raiz: Nodo;
  try {
    raiz = parserRaiz.parse(cuerpo) as Nodo;
  } catch {
    return false;
  }
  const claves = Object.keys(raiz).filter((k) => k !== '#text' && k !== '#comment');
  if (claves.length !== 1 || (typeof raiz['#text'] === 'string' && raiz['#text'].trim() !== '')) return false;
  const m = /^(?:([A-Za-z_][\w.-]*):)?Envelope$/.exec(claves[0]!);
  if (!m) return false;
  const sobre = nodo(raiz[claves[0]!]);
  if (!sobre) return false;
  const declaracion = m[1] ? sobre[`@_xmlns:${m[1]}`] : sobre['@_xmlns'];
  return declaracion === NS_SOAP12;
}

/** Elementos hijos de `n` con ese nombre local (cualquier prefijo), aplanando repetidos. */
function hijosLocales(n: Nodo, local: string): { clave: string; valor: unknown }[] {
  const r: { clave: string; valor: unknown }[] = [];
  for (const [clave, valor] of Object.entries(n)) {
    if (clave.startsWith('@_') || clave.startsWith('#')) continue;
    if (clave.split(':').pop() !== local) continue;
    for (const v of Array.isArray(valor) ? valor : [valor]) r.push({ clave, valor: v });
  }
  return r;
}

/** Ámbito de namespaces del hijo: el del padre más lo que declare el propio elemento. */
function ambitoDe(padre: Readonly<Record<string, string>>, valor: unknown): Record<string, string> {
  const ambito = { ...padre };
  const n = nodo(valor);
  if (!n) return ambito;
  for (const [k, v] of Object.entries(n)) {
    if (typeof v !== 'string') continue;
    if (k === '@_xmlns') ambito[''] = v;
    else if (k.startsWith('@_xmlns:')) ambito[k.slice('@_xmlns:'.length)] = v;
  }
  return ambito;
}

function namespaceDe(clave: string, ambito: Readonly<Record<string, string>>): string | undefined {
  const i = clave.indexOf(':');
  return ambito[i >= 0 ? clave.slice(0, i) : ''];
}

/**
 * Todo `IsValid` del resultado (o de cada `DianResponse` del lote) tiene que
 * estar en el namespace del DataContract `DianResponse`. El parser principal
 * quita los prefijos, así que esta revisión vuelve a leer con prefijos y
 * resuelve las declaraciones `xmlns` desde la raíz.
 */
function isValidEnNamespace(cuerpo: string, op: OperacionDian): boolean {
  let raiz: Nodo;
  try {
    raiz = parserRaiz.parse(cuerpo) as Nodo;
  } catch {
    return false;
  }
  let nivel: { valor: unknown; ambito: Record<string, string> }[] = [{ valor: raiz, ambito: {} }];
  const camino = ['Envelope', 'Body', `${op}Response`, `${op}Result`, ...(op === 'GetStatusZip' ? ['DianResponse'] : [])];
  for (const local of camino) {
    const siguiente: typeof nivel = [];
    for (const { valor, ambito } of nivel) {
      const n = nodo(valor);
      if (!n) continue;
      for (const h of hijosLocales(n, local)) siguiente.push({ valor: h.valor, ambito: ambitoDe(ambito, h.valor) });
    }
    nivel = siguiente;
  }
  for (const { valor, ambito } of nivel) {
    const n = nodo(valor);
    if (!n) continue;
    for (const h of hijosLocales(n, 'IsValid')) {
      if (namespaceDe(h.clave, ambitoDe(ambito, h.valor)) !== NS_DIAN_RESPONSE) return false;
    }
  }
  return true;
}

/**
 * Mensajes: sin saltos, cortos, sin bloques base64 largos (podrían ser el XML o
 * un certificado) y sin claves en hex de 40 a 64 caracteres (la TechnicalKey).
 * Un CUFE/CUDE (96 hex, SHA-384) no es secreto y se deja: ayuda a ubicar el
 * documento en el mensaje.
 */
const MAX_MENSAJES = 50;
const MAX_LARGO_MENSAJE = 500;
const CLAVE_HEX = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{40,64}(?![0-9A-Fa-f])/g;
export function limpiarMensaje(m: string): string {
  const limpio = m
    .replace(/[A-Za-z0-9+/=]{100,}/g, '[omitido]')
    .replace(CLAVE_HEX, '[omitido]')
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
  if (!raizEsSobreSoap12(cuerpo)) return { tipo: 'ilegible' };
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
  esperado: EsperadoDian = {},
): RespuestaDian {
  const p = parsearSobre(cuerpo, op);
  const previo = previoAlCuerpo(p, status);
  if (previo) return previo;
  const resultado = (p as Extract<Parseo, { tipo: 'cuerpo' }>).resultado;

  if (op === 'SendTestSetAsync') return mapearAsincrono(resultado);
  // Un IsValid de otro namespace no es el veredicto de la DIAN.
  if (!isValidEnNamespace(cuerpo, op)) return respuestaRed('El IsValid de la respuesta no es el de la DIAN');
  if (op === 'GetStatusZip') {
    const items = lista(resultado.DianResponse).map(nodo);
    if (items.some((i) => !i)) return respuestaRed('Una respuesta del lote no se pudo leer');
    // Lote aún sin respuestas: sigue en validación.
    if (items.length === 0) {
      return cerrar({ ok: false, codigo: 'PENDIENTE_DIAN', origen: 'dian', mensajes: ['La DIAN aún valida el lote'] });
    }
    const elegido = elegirDelLote(items as Nodo[], esperado);
    if (!elegido) return respuestaRed('La respuesta del lote no corresponde al documento consultado');
    return mapearDianResponse(elegido, op, esperado);
  }
  return mapearDianResponse(resultado, op, esperado);
}

function mismoCufe(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * El `DianResponse` del documento: con CUFE esperado, el que lo trae; sin él,
 * solo si el lote tiene una única respuesta (si no, no se sabe cuál es).
 */
function elegirDelLote(items: Nodo[], esperado: EsperadoDian): Nodo | undefined {
  const cufe = esperado.cufe?.trim();
  if (cufe) {
    const delDoc = items.filter((i) => {
      const k = texto(i.XmlDocumentKey);
      return k !== undefined && mismoCufe(k, cufe);
    });
    if (delDoc.length === 1) return delDoc[0];
    // Una sola respuesta sin clave: se acepta y la valida mapearDianResponse.
    if (items.length === 1 && !texto(items[0]!.XmlDocumentKey)) return items[0];
    return undefined;
  }
  return items.length === 1 ? items[0] : undefined;
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

/** Tope de la ApplicationResponse decodificada (las reales pesan pocos KB). */
export const MAX_BYTES_APPLICATION_RESPONSE = 1024 * 1024;

const parserAr = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/**
 * `XmlBase64Bytes` → base64 saneado, o `undefined` si no sirve: base64 bien
 * formado, dentro del tope, XML sin DOCTYPE ni entidades con raíz única
 * `ApplicationResponse`, y cuyo `DocumentReference/UUID` es el CUFE esperado.
 */
function extraerApplicationResponse(crudo: unknown, cufe: string): string | undefined {
  const b64 = typeof crudo === 'string' ? crudo.replace(/\s+/g, '') : '';
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return undefined;
  if (Math.floor((b64.length * 3) / 4) > MAX_BYTES_APPLICATION_RESPONSE) return undefined;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_BYTES_APPLICATION_RESPONSE) return undefined;
  const xml = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (xml.includes('�') || traeDoctype(xml) || /<!ENTITY/i.test(xml)) return undefined;
  if (XMLValidator.validate(xml) !== true) return undefined;
  let raiz: Nodo;
  try {
    raiz = parserAr.parse(xml) as Nodo;
  } catch {
    return undefined;
  }
  const claves = Object.keys(raiz).filter((k) => k !== '#text' && k !== '#comment');
  if (claves.length !== 1 || claves[0]!.split(':').pop() !== 'ApplicationResponse') return undefined;
  const respuesta = xml.match(/<(?:\w+:)?DocumentResponse[\s>][\s\S]*?<\/(?:\w+:)?DocumentResponse>/)?.[0] ?? '';
  const referencia = respuesta.match(/<(?:\w+:)?DocumentReference[\s>][\s\S]*?<\/(?:\w+:)?DocumentReference>/)?.[0] ?? '';
  const uuid = referencia.match(/<(?:\w+:)?UUID[^>]*>\s*([^<]+?)\s*</)?.[1];
  if (!uuid || !mismoCufe(uuid, cufe)) return undefined;
  return b64;
}

/** Un `DianResponse` (SendBillSync, GetStatus, cada ítem de GetStatusZip). */
function mapearDianResponse(r: Nodo, op: OperacionDian, esperado: EsperadoDian = {}): RespuestaDian {
  // IsValid debe ser texto puro: ni repetido, ni con atributos, ni con contenido mixto.
  if (typeof r.IsValid !== 'string') return respuestaRed('La respuesta de la DIAN no trae un IsValid legible');
  const isValid = r.IsValid.trim().toLowerCase();
  const statusCode = texto(r.StatusCode);
  const descripcion = texto(r.StatusDescription) ?? '';
  const errores = erroresDe(r);
  const cufe = texto(r.XmlDocumentKey) || undefined;
  // La respuesta tiene que hablar del documento que se envió o consultó.
  if (cufe && esperado.cufe?.trim() && !mismoCufe(cufe, esperado.cufe)) {
    return respuestaRed('La respuesta de la DIAN corresponde a otro documento');
  }
  const base = { origen: 'dian' as const, ...(cufe ? { cufe } : {}) };
  const mensajes = [descripcion, ...errores].filter(Boolean);

  if (isValid === 'true') {
    // Aceptar exige saber de qué documento habla: con CUFE esperado, la clave es obligatoria.
    if (esperado.cufe?.trim() && !cufe) {
      return respuestaRed('La DIAN aceptó sin decir qué documento (falta XmlDocumentKey)');
    }
    // El XML de la ApplicationResponse solo se conserva si es válido y es de ESTE
    // documento; si no, se descarta sin tocar el veredicto.
    const applicationResponse = cufe ? extraerApplicationResponse(r.XmlBase64Bytes, cufe) : undefined;
    return cerrar({
      ...base,
      ok: true,
      isValid: true,
      codigo: statusCode,
      mensajes,
      ...(applicationResponse ? { applicationResponse } : {}),
    });
  }
  if (isValid !== 'false') return respuestaRed('La respuesta de la DIAN no trae IsValid');

  if (errores.some((e) => PATRON_YA_PROCESADO.test(e)) || PATRON_YA_PROCESADO.test(descripcion)) {
    return cerrar({ ...base, ok: false, codigo: 'YA_PROCESADO_DIAN', mensajes });
  }
  if (PATRON_EN_PROCESO.test(descripcion) && errores.length === 0) {
    return cerrar({ ...base, ok: false, codigo: 'PENDIENTE_DIAN', mensajes });
  }
  // GetStatus de un documento que la DIAN no tiene: nunca llegó, no es rechazo.
  // Solo con el StatusCode de «no encontrado», o con la descripción y SIN errores:
  // un rechazo real (p. ej. FAK24) puede decir «no encontrado» en un ErrorMessage.
  if (
    op === 'GetStatus' &&
    ((statusCode !== undefined && (STATUS_NO_ENCONTRADO as readonly string[]).includes(statusCode)) ||
      (errores.length === 0 && PATRON_NO_ENCONTRADO.test(descripcion)))
  ) {
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
    // No es un veredicto sobre ningún documento: casi siempre es software o NIT sin
    // asociar en la DIAN. Sin isValid y con un código de la lista sin veredicto.
    return cerrar({
      ok: false,
      codigo: 'CONFIG_FALTANTE',
      origen: 'dian',
      mensajes: [`OperationCode ${codigo}: ${descripcion}`],
      rangos: [],
    });
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
