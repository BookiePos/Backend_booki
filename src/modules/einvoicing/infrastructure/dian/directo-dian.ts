import type { TipoAmbiente } from '../../domain/emisor-fiscal';
import {
  assertContratoRespuesta,
  type ConsultaDian,
  type EnvioDian,
  type EnvioSetPruebasDian,
  type RespuestaDian,
  type RespuestaRangosDian,
  type TransmisorDian,
} from '../../domain/transmisor-dian';
import {
  MAX_BYTES_RESPUESTA,
  PRESUPUESTO_POR_DEFECTO_MS,
  URL_DIAN_POR_AMBIENTE,
  type OperacionDian,
  type ParteFirmada,
} from './dian.constants';
import {
  mapearRespuestaDocumento,
  mapearRespuestaRangos,
  respuestaRed,
  type EsperadoDian,
} from './mapeo-respuesta';
import { anioColombia, consecutivoDeNumero, nombresArchivo } from './nombre-archivo';
import { contentTypeSoap, sobreFirmado, type CredencialSoap, type ParametrosOperacion } from './sobre-soap';
import { zipUnArchivo } from './zip-memoria';

/**
 * Transmisor directo a la DIAN: SOAP 1.2 + WS-Security firmado con el .p12 del
 * propio emisor. Nunca hay credencial global: el material, el ambiente y el
 * SoftwareID llegan del emisor en la fábrica.
 *
 * Nada de lo que devuelve, lanza o serializa lleva la llave, el PIN, la
 * contraseña del .p12 ni la clave técnica, y no escribe logs. La llave vive en
 * un campo `#privado`: ni `JSON.stringify` ni `util.inspect` lo ven.
 */

/** Cuerpo en streaming, compatible con `ReadableStream` de fetch. */
export interface CuerpoStreaming {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(motivo?: unknown): Promise<void>;
    releaseLock?(): void;
  };
}

/** Respuesta HTTP mínima que se necesita (compatible con `Response` de fetch). */
export interface RespuestaHttp {
  status: number;
  headers?: { get(nombre: string): string | null };
  /** Si viene, se lee en streaming contando bytes (preferido). */
  body?: CuerpoStreaming | null;
  /** Respaldo para transportes sin streaming. */
  text?(): Promise<string>;
}

export interface PeticionHttp {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  /** Nunca se sigue una redirección: un 3xx es `RED`. */
  redirect: 'manual';
}

/** Transporte inyectable; por defecto, `fetch` nativo. */
export type TransporteHttp = (url: string, init: PeticionHttp) => Promise<RespuestaHttp>;

const transporteFetch: TransporteHttp = (url, init) => fetch(url, init);

export interface ConfigDirectoDian {
  /** Llave y certificado del emisor (de `abrirP12`). */
  material: CredencialSoap;
  /** Ambiente del emisor. Obligatorio: no hay ambiente por defecto. */
  tipoAmbiente: TipoAmbiente;
  softwareId: string;
  /** NIT del emisor, solo dígitos y SIN dígito de verificación. */
  nit: string;
  /** NIT del proveedor tecnológico (`accountCodeT`), sin DV; software propio = el del emisor. */
  nitProveedor?: string;
  /** Código del proveedor tecnológico en el nombre del archivo (`000` = propio). */
  codigoPt?: string;
  transporte?: TransporteHttp;
  /** Presupuesto por llamada (ms). Vencido = `RED`. */
  presupuestoMs?: number;
  /** Presupuesto por operación, si alguna necesita otro. */
  presupuestosMs?: Partial<Record<OperacionDian, number>>;
  partesFirmadas?: readonly ParteFirmada[];
  reloj?: () => Date;
}

/**
 * Presupuesto que puede traer cada llamada (lo añade el PR de la orquestación a
 * `EnvioDian`/`ConsultaDian`). Tipo local y compatible para no tocar el puerto
 * aquí: se respeta si viene y gana el menor frente al configurado.
 */
export interface OpcionesLlamadaDian {
  signal?: AbortSignal;
  presupuestoMs?: number;
}

const VENCIDO = Symbol('vencido');

class TopeSuperado extends Error {}

function configFaltante(mensaje: string): RespuestaDian {
  const r: RespuestaDian = { ok: false, codigo: 'CONFIG_FALTANTE', origen: 'adapter', mensajes: [mensaje] };
  assertContratoRespuesta(r);
  return r;
}

/**
 * NIT sin DV: solo dígitos (se toleran puntos de miles y espacios). Un guion
 * indica DV pegado y se rechaza: quitarlo a ciegas lo sumaría al NIT.
 */
export function nitSinDv(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const limpio = v.trim().replace(/[.\s]/g, '');
  return /^\d{1,10}$/.test(limpio) ? limpio : null;
}

/** Lee el cuerpo contando BYTES; corta al pasar el tope. */
async function leerCuerpoLimitado(res: RespuestaHttp, max: number, control: AbortController): Promise<string> {
  const declarado = res.headers?.get('content-length');
  if (declarado && /^\d+$/.test(declarado.trim()) && Number(declarado) > max) {
    control.abort();
    throw new TopeSuperado();
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const lector = res.body.getReader();
    const partes: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        control.abort();
        await lector.cancel().catch(() => undefined);
        throw new TopeSuperado();
      }
      partes.push(value);
    }
    // UTF-8 estricto: bytes inválidos = cuerpo ilegible.
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(partes));
  }
  if (typeof res.text !== 'function') throw new Error('respuesta sin cuerpo');
  const cuerpo = await res.text();
  if (typeof cuerpo !== 'string' || Buffer.byteLength(cuerpo, 'utf8') > max) throw new TopeSuperado();
  return cuerpo;
}

export class DirectoDian implements TransmisorDian {
  // Campos `#privados`: no salen en JSON.stringify ni en util.inspect.
  readonly #credencial: CredencialSoap;
  readonly #url: string;
  readonly #transporte: TransporteHttp;
  readonly #reloj: () => Date;
  readonly #softwareId: string;
  readonly #nit: string;
  readonly #nitProveedor: string | undefined;
  readonly #codigoPt: string | undefined;
  readonly #presupuestoMs: number;
  readonly #presupuestosMs: Partial<Record<OperacionDian, number>>;
  readonly #partes: readonly ParteFirmada[] | undefined;

  constructor(cfg: ConfigDirectoDian) {
    // Clave propia y de tipo string (equivale a Object.hasOwn, que el lib de tsconfig no declara):
    // '__proto__', 'toString' o un número no eligen URL.
    const amb: unknown = cfg.tipoAmbiente;
    if (typeof amb !== 'string' || !Object.prototype.hasOwnProperty.call(URL_DIAN_POR_AMBIENTE, amb)) {
      throw new Error('Ambiente DIAN inválido: debe ser 1 (producción) o 2 (habilitación)');
    }
    if (typeof cfg.softwareId !== 'string' || !cfg.softwareId.trim()) throw new Error('Falta el SoftwareID del emisor');
    const nit = nitSinDv(cfg.nit);
    if (!nit) throw new Error('NIT del emisor inválido: solo dígitos, sin guion ni dígito de verificación');
    let nitProveedor: string | undefined;
    if (cfg.nitProveedor !== undefined) {
      const n = nitSinDv(cfg.nitProveedor);
      if (!n) throw new Error('NIT del proveedor tecnológico inválido: sin guion ni dígito de verificación');
      nitProveedor = n;
    }
    if (!cfg.material?.llavePem || !cfg.material.certificadoB64) throw new Error('Falta el certificado del emisor');

    this.#credencial = { llavePem: cfg.material.llavePem, certificadoB64: cfg.material.certificadoB64 };
    this.#url = URL_DIAN_POR_AMBIENTE[amb as TipoAmbiente];
    this.#transporte = cfg.transporte ?? transporteFetch;
    this.#reloj = cfg.reloj ?? (() => new Date());
    this.#softwareId = cfg.softwareId.trim();
    this.#nit = nit;
    this.#nitProveedor = nitProveedor;
    this.#codigoPt = cfg.codigoPt;
    this.#presupuestoMs = cfg.presupuestoMs ?? PRESUPUESTO_POR_DEFECTO_MS;
    this.#presupuestosMs = { ...cfg.presupuestosMs };
    this.#partes = cfg.partesFirmadas;
  }

  /** URL a la que habla este transmisor (según el ambiente del emisor). */
  get urlServicio(): string {
    return this.#url;
  }

  /** Lo único que se muestra al serializar: nada sensible. */
  toJSON(): { transmisor: 'DirectoDian'; url: string } {
    return { transmisor: 'DirectoDian', url: this.#url };
  }

  async enviar(entrada: EnvioDian & OpcionesLlamadaDian): Promise<RespuestaDian> {
    const archivo = this.#empaquetar(entrada);
    if ('respuesta' in archivo) return archivo.respuesta;
    return this.#documento(
      'SendBillSync',
      [
        ['fileName', archivo.nombre],
        ['contentFile', archivo.base64],
      ],
      entrada,
      { cufe: entrada.cufe },
    );
  }

  async enviarSetPruebas(entrada: EnvioSetPruebasDian & OpcionesLlamadaDian): Promise<RespuestaDian> {
    if (!entrada.testSetId?.trim()) return configFaltante('Falta el TestSetId del set de pruebas');
    const archivo = this.#empaquetar(entrada);
    if ('respuesta' in archivo) return archivo.respuesta;
    return this.#documento(
      'SendTestSetAsync',
      [
        ['fileName', archivo.nombre],
        ['contentFile', archivo.base64],
        ['testSetId', entrada.testSetId.trim()],
      ],
      entrada,
    );
  }

  /**
   * Con `trackId` (ZipKey de un envío asíncrono) consulta GetStatusZip; si solo
   * hay CUFE/CUDE, GetStatus. El CUFE, si viene, se exige en la respuesta.
   */
  async consultar(consulta: ConsultaDian & OpcionesLlamadaDian): Promise<RespuestaDian> {
    const esperado = { cufe: consulta.cufe };
    if (consulta.trackId?.trim()) {
      return this.#documento('GetStatusZip', [['trackId', consulta.trackId.trim()]], consulta, esperado);
    }
    if (consulta.cufe?.trim()) {
      return this.#documento('GetStatus', [['trackId', consulta.cufe.trim()]], consulta, esperado);
    }
    return configFaltante('La consulta necesita trackId o CUFE');
  }

  async rangos(nit: string): Promise<RespuestaRangosDian> {
    const accountCode = nitSinDv(nit);
    if (!accountCode) {
      return { ...configFaltante('NIT inválido para consultar rangos: solo dígitos, sin guion ni DV'), rangos: [] };
    }
    const http = await this.#llamar('GetNumberingRange', [
      ['accountCode', accountCode],
      ['accountCodeT', this.#nitProveedor ?? accountCode],
      ['softwareCode', this.#softwareId],
    ]);
    if ('respuesta' in http) return { ...http.respuesta, rangos: [] };
    return mapearRespuestaRangos(http.status, http.cuerpo);
  }

  #empaquetar(e: EnvioDian): { nombre: string; base64: string } | { respuesta: RespuestaDian } {
    if (!e.xmlFirmado?.trim()) return { respuesta: configFaltante('Falta el XML firmado del documento') };
    try {
      const ahora = this.#reloj();
      const nombres = nombresArchivo({
        tipo: e.tipo,
        nit: this.#nit,
        consecutivo: consecutivoDeNumero(e.fullNumber),
        anio: anioColombia(ahora),
        codigoPt: this.#codigoPt,
      });
      const zip = zipUnArchivo(nombres.xml, e.xmlFirmado, ahora);
      return { nombre: nombres.zip, base64: zip.toString('base64') };
    } catch {
      return { respuesta: configFaltante('No se pudo armar el archivo para la DIAN (número o NIT inválido)') };
    }
  }

  async #documento(
    op: Exclude<OperacionDian, 'GetNumberingRange'>,
    params: ParametrosOperacion,
    opc?: OpcionesLlamadaDian,
    esperado?: EsperadoDian,
  ): Promise<RespuestaDian> {
    const http = await this.#llamar(op, params, opc);
    if ('respuesta' in http) return http.respuesta;
    return mapearRespuestaDocumento(op, http.status, http.cuerpo, esperado);
  }

  /** Firma, envía y lee dentro del presupuesto. Cualquier fallo de red es `RED`. */
  async #llamar(
    op: OperacionDian,
    params: ParametrosOperacion,
    opc: OpcionesLlamadaDian = {},
  ): Promise<{ status: number; cuerpo: string } | { respuesta: RespuestaDian }> {
    // Un presupuesto ya vencido no sale a la red.
    if (opc.signal?.aborted) return { respuesta: respuestaRed('Se agotó el presupuesto antes de llamar a la DIAN') };
    let sobre: string;
    try {
      sobre = sobreFirmado(op, this.#url, params, this.#credencial, {
        ahora: this.#reloj(),
        partes: this.#partes,
      });
    } catch {
      // El error de xml-crypto/crypto podría citar la llave: mensaje fijo.
      return { respuesta: configFaltante('No se pudo armar o firmar el mensaje para la DIAN') };
    }

    const configurado = this.#presupuestosMs[op] ?? this.#presupuestoMs;
    const pedido = opc.presupuestoMs;
    const ms =
      typeof pedido === 'number' && Number.isFinite(pedido) ? Math.max(0, Math.min(configurado, pedido)) : configurado;
    const control = new AbortController();
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    let alAbortar: (() => void) | undefined;
    const vencido = new Promise<typeof VENCIDO>((resolve) => {
      const cortar = (): void => {
        control.abort();
        resolve(VENCIDO);
      };
      temporizador = setTimeout(cortar, ms);
      // La señal del llamador corta igual que el temporizador propio: gana el que llegue primero.
      if (opc.signal) {
        alAbortar = cortar;
        opc.signal.addEventListener('abort', alAbortar, { once: true });
      }
    });
    try {
      const intento = (async (): Promise<{ status: number; cuerpo: string } | 'redireccion'> => {
        const res = await this.#transporte(this.#url, {
          method: 'POST',
          headers: { 'Content-Type': contentTypeSoap(op), Accept: 'application/soap+xml' },
          body: sobre,
          signal: control.signal,
          redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
          control.abort();
          return 'redireccion';
        }
        const cuerpo = await leerCuerpoLimitado(res, MAX_BYTES_RESPUESTA, control);
        return { status: res.status, cuerpo };
      })();
      // Si el transporte ignora la señal, la carrera igual corta a tiempo.
      intento.catch(() => undefined);
      const r = await Promise.race([intento, vencido]);
      if (r === VENCIDO) {
        return { respuesta: respuestaRed('La DIAN no respondió dentro del presupuesto de tiempo') };
      }
      if (r === 'redireccion') {
        return { respuesta: respuestaRed('La DIAN respondió con una redirección; no se sigue') };
      }
      return r;
    } catch (e) {
      if (e instanceof TopeSuperado) {
        return { respuesta: respuestaRed('La respuesta de la DIAN supera el tamaño máximo') };
      }
      return { respuesta: respuestaRed('No se pudo conectar con la DIAN') };
    } finally {
      clearTimeout(temporizador);
      if (alAbortar) opc.signal?.removeEventListener('abort', alAbortar);
    }
  }
}

/**
 * Fábrica para que `resolverTransmisor` la conecte (otro PR). `tipoAmbiente` es
 * obligatorio y sin valor por defecto: si falta o no es '1'/'2', lanza.
 */
export function crearDirectoDian(cfg: ConfigDirectoDian): DirectoDian {
  return new DirectoDian(cfg);
}
