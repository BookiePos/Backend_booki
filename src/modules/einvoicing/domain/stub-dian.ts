import type {
  ConsultaDian,
  EnvioDian,
  EnvioSetPruebasDian,
  RespuestaDian,
  RespuestaRangosDian,
  TransmisorDian,
} from "./transmisor-dian";

/**
 * Transmisor de relleno: nunca sale a la red y nunca acepta. Responde
 * `CONFIG_FALTANTE` (origen adaptador, sin veredicto), de modo que el documento
 * se queda donde estaba (`draft`/`signed`).
 */
export class StubDian implements TransmisorDian {
  constructor(
    private readonly motivo = "Transmisión a la DIAN no configurada",
  ) {}

  private respuesta(): RespuestaDian {
    return {
      ok: false,
      codigo: "CONFIG_FALTANTE",
      origen: "adapter",
      mensajes: [this.motivo],
    };
  }

  enviar(_entrada: EnvioDian): Promise<RespuestaDian> {
    return Promise.resolve(this.respuesta());
  }

  enviarSetPruebas(_entrada: EnvioSetPruebasDian): Promise<RespuestaDian> {
    return Promise.resolve(this.respuesta());
  }

  consultar(_consulta: ConsultaDian): Promise<RespuestaDian> {
    return Promise.resolve(this.respuesta());
  }

  rangos(_nit: string): Promise<RespuestaRangosDian> {
    return Promise.resolve({ ...this.respuesta(), rangos: [] });
  }
}
