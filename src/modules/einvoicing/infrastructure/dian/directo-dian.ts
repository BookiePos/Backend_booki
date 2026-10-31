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
import { mapearRespuestaDocumento, mapearRespuestaRangos, respuestaRed } from './mapeo-respuesta';
import { anioColombia, consecutivoDeNumero, nombresArchivo } from './nombre-archivo';
import { contentTypeSoap, sobreFirmado, type CredencialSoap, type ParametrosOperacion } from './sobre-soap';
import { zipUnArchivo } from './zip-memoria';

/**
 * Transmisor directo a la DIAN: SOAP 1.2 + WS-Security firmado con el .p12 del
 * propio emisor. Nunca hay credencial global: el material, el ambiente y el
 * SoftwareID llegan del emisor en la fábrica.
 *
 * Nada de lo que devuelve o lanza lleva la llave, el PIN, la contraseña del .p12
 * ni la clave técnica, y no escribe logs.
 */

/** Respuesta HTTP mínima que se necesita (compatible con `Response` de fetch). */
export interface RespuestaHttp {
  status: number;
  text(): Promise<string>;
}

export interface PeticionHttp {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
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
  /** NIT del emisor sin DV (nombre de los archivos). */
  nit: string;
  /** NIT del proveedor tecnológico (`accountCodeT`); software propio = el del emisor. */
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

const VENCIDO = Symbol('vencido');

function configFaltante(mensaje: string): RespuestaDian {
  const r: RespuestaDian = { ok: false, codigo: 'CONFIG_FALTANTE', origen: 'adapter', mensajes: [mensaje] };
  assertContratoRespuesta(r);
  return r;
}

export class DirectoDian implements TransmisorDian {
  private readonly url: string;
  private readonly transporte: TransporteHttp;
  private readonly reloj: () => Date;

  constructor(private readonly cfg: ConfigDirectoDian) {
    const url = URL_DIAN_POR_AMBIENTE[cfg.tipoAmbiente];
    if (!url) throw new Error('Ambiente DIAN inválido: debe ser 1 (producción) o 2 (habilitación)');
    if (!cfg.softwareId?.trim()) throw new Error('Falta el SoftwareID del emisor');
    if (!/^\d{1,10}$/.test(cfg.nit?.replace(/\D/g, '') ?? '')) throw new Error('NIT del emisor inválido');
    this.url = url;
    this.transporte = cfg.transporte ?? transporteFetch;
    this.reloj = cfg.reloj ?? (() => new Date());
  }

  /** URL a la que habla este transmisor (según el ambiente del emisor). */
  get urlServicio(): string {
    return this.url;
  }

  async enviar(entrada: EnvioDian): Promise<RespuestaDian> {
    const archivo = this.empaquetar(entrada);
    if ('respuesta' in archivo) return archivo.respuesta;
    return this.documento('SendBillSync', [
      ['fileName', archivo.nombre],
      ['contentFile', archivo.base64],
    ]);
  }

  async enviarSetPruebas(entrada: EnvioSetPruebasDian): Promise<RespuestaDian> {
    if (!entrada.testSetId?.trim()) return configFaltante('Falta el TestSetId del set de pruebas');
    const archivo = this.empaquetar(entrada);
    if ('respuesta' in archivo) return archivo.respuesta;
    return this.documento('SendTestSetAsync', [
      ['fileName', archivo.nombre],
      ['contentFile', archivo.base64],
      ['testSetId', entrada.testSetId.trim()],
    ]);
  }

  /**
   * Con `trackId` (ZipKey de un envío asíncrono) consulta GetStatusZip; si solo
   * hay CUFE/CUDE, GetStatus.
   */
  async consultar(consulta: ConsultaDian): Promise<RespuestaDian> {
    if (consulta.trackId?.trim()) {
      return this.documento('GetStatusZip', [['trackId', consulta.trackId.trim()]]);
    }
    if (consulta.cufe?.trim()) {
      return this.documento('GetStatus', [['trackId', consulta.cufe.trim()]]);
    }
    return configFaltante('La consulta necesita trackId o CUFE');
  }

  async rangos(nit: string): Promise<RespuestaRangosDian> {
    const accountCode = nit?.replace(/\D/g, '') ?? '';
    if (!accountCode) return { ...configFaltante('Falta el NIT para consultar rangos'), rangos: [] };
    const accountCodeT = (this.cfg.nitProveedor ?? accountCode).replace(/\D/g, '');
    const http = await this.llamar('GetNumberingRange', [
      ['accountCode', accountCode],
      ['accountCodeT', accountCodeT],
      ['softwareCode', this.cfg.softwareId.trim()],
    ]);
    if ('respuesta' in http) return { ...http.respuesta, rangos: [] };
    return mapearRespuestaRangos(http.status, http.cuerpo);
  }

  private empaquetar(
    e: EnvioDian,
  ): { nombre: string; base64: string } | { respuesta: RespuestaDian } {
    if (!e.xmlFirmado?.trim()) return { respuesta: configFaltante('Falta el XML firmado del documento') };
    let nombres;
    try {
      const ahora = this.reloj();
      nombres = nombresArchivo({
        tipo: e.tipo,
        nit: this.cfg.nit,
        consecutivo: consecutivoDeNumero(e.fullNumber),
        anio: anioColombia(ahora),
        codigoPt: this.cfg.codigoPt,
      });
      const zip = zipUnArchivo(nombres.xml, e.xmlFirmado, ahora);
      return { nombre: nombres.zip, base64: zip.toString('base64') };
    } catch {
      return { respuesta: configFaltante('No se pudo armar el archivo para la DIAN (número o NIT inválido)') };
    }
  }

  private async documento(
    op: Exclude<OperacionDian, 'GetNumberingRange'>,
    params: ParametrosOperacion,
  ): Promise<RespuestaDian> {
    const http = await this.llamar(op, params);
    if ('respuesta' in http) return http.respuesta;
    return mapearRespuestaDocumento(op, http.status, http.cuerpo);
  }

  /** Firma, envía y lee dentro del presupuesto. Cualquier fallo de red es `RED`. */
  private async llamar(
    op: OperacionDian,
    params: ParametrosOperacion,
  ): Promise<{ status: number; cuerpo: string } | { respuesta: RespuestaDian }> {
    let sobre: string;
    try {
      sobre = sobreFirmado(op, this.url, params, this.cfg.material, {
        ahora: this.reloj(),
        partes: this.cfg.partesFirmadas,
      });
    } catch {
      // El error de xml-crypto/crypto podría citar la llave: mensaje fijo.
      return { respuesta: configFaltante('No se pudo firmar el mensaje para la DIAN con el certificado del emisor') };
    }

    const ms = this.cfg.presupuestosMs?.[op] ?? this.cfg.presupuestoMs ?? PRESUPUESTO_POR_DEFECTO_MS;
    const control = new AbortController();
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const vencido = new Promise<typeof VENCIDO>((resolve) => {
      temporizador = setTimeout(() => {
        control.abort();
        resolve(VENCIDO);
      }, ms);
    });
    try {
      const intento = (async () => {
        const res = await this.transporte(this.url, {
          method: 'POST',
          headers: { 'Content-Type': contentTypeSoap(op), Accept: 'application/soap+xml' },
          body: sobre,
          signal: control.signal,
        });
        const cuerpo = await res.text();
        return { status: res.status, cuerpo };
      })();
      // Si el transporte ignora la señal, la carrera igual corta a tiempo.
      intento.catch(() => undefined);
      const r = await Promise.race([intento, vencido]);
      if (r === VENCIDO) {
        return { respuesta: respuestaRed(`La DIAN no respondió en ${ms} ms`) };
      }
      if (typeof r.cuerpo !== 'string' || r.cuerpo.length > MAX_BYTES_RESPUESTA) {
        return { respuesta: respuestaRed('La respuesta de la DIAN no se pudo leer') };
      }
      return r;
    } catch {
      return { respuesta: respuestaRed('No se pudo conectar con la DIAN') };
    } finally {
      clearTimeout(temporizador);
    }
  }
}

/** Fábrica para que `resolverTransmisor` la conecte (otro PR). */
export function crearDirectoDian(cfg: ConfigDirectoDian): DirectoDian {
  return new DirectoDian(cfg);
}
