/**
 * Motivos de rechazo (y de «no salió») de un documento electrónico, en frases
 * que el negocio entienda. Dominio puro: sin Nest ni Mongoose.
 *
 * La DIAN responde con mensajes del estilo «Regla: FAJ43b, Rechazo: …». Aquí se
 * separan la regla y el texto, se acotan y se añade, cuando se conoce, qué hacer.
 * Nunca se inventa una causa: lo que no se reconoce se muestra tal cual vino.
 */

export interface MotivoLegible {
  /** Regla de validación de la DIAN (p. ej. FAJ43b), si el mensaje la trae. */
  regla?: string;
  /** Lo que dijo la DIAN (o el adaptador), recortado. */
  texto: string;
  /** Qué hacer, solo si se conoce. */
  sugerencia?: string;
}

const MAX_MOTIVOS = 10;
const MAX_TEXTO = 400;

const SUGERENCIAS_POR_CODIGO: Record<string, string> = {
  RED: 'No se pudo hablar con la DIAN. Reintenta en unos minutos; el documento conserva su número.',
  PENDIENTE_DIAN: 'La DIAN todavía está validando el documento. Espera un momento y vuelve a consultar.',
  NO_RECIBIDO_DIAN: 'La DIAN no confirma haber recibido el documento. Reintenta el envío: se reenvía el mismo XML.',
  CONFIG_FALTANTE:
    'Falta configurar algo del emisor (certificado, SoftwareID, PIN, resolución o ambiente) y el documento no salió a la DIAN.',
  YA_PROCESADO_DIAN: 'La DIAN ya había procesado este documento; se consulta su estado en lugar de reenviarlo.',
  EN_CURSO: 'Otra transmisión de este documento está en curso.',
};

const SUGERENCIAS_POR_REGLA: Record<string, string> = {
  FAJ43b: 'El nombre del adquiriente no coincide con el del RUT. Corrige el nombre o la razón social del cliente.',
  FAU04: 'Los totales de impuestos del documento no cuadran con sus líneas. Revisa la venta de origen.',
};

const REGLA = /Regla:\s*([A-Za-z0-9_-]{1,20})\s*,?\s*(?:Rechazo|Notificaci[oó]n)?:?\s*(.*)$/is;

function recortar(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXTO);
}

/** Convierte un mensaje crudo en un motivo; vacío → `null`. */
export function motivoDeMensaje(crudo: unknown): MotivoLegible | null {
  const texto = recortar(crudo);
  if (!texto) return null;
  const m = REGLA.exec(texto);
  if (m) {
    const regla = m[1]!;
    return {
      regla,
      texto: recortar(m[2]) || texto,
      ...(SUGERENCIAS_POR_REGLA[regla] ? { sugerencia: SUGERENCIAS_POR_REGLA[regla] } : {}),
    };
  }
  return { texto };
}

export interface FuenteMotivos {
  dianStatus?: string;
  rechazoMotivo?: string | null;
  respuestaDian?: Record<string, unknown> | null;
  ultimoIntentoSinRed?: Record<string, unknown> | null;
}

/**
 * Motivos del documento: los mensajes de la última respuesta de la DIAN (o, si
 * no los hay, el `rechazoMotivo` guardado) y, aparte, por qué el último intento
 * no salió a la red. Un documento aceptado no tiene motivos.
 */
export function motivosLegibles(doc: FuenteMotivos): MotivoLegible[] {
  if (doc.dianStatus === 'accepted') return [];
  const salida: MotivoLegible[] = [];
  const visto = new Set<string>();
  const agregar = (crudo: unknown, codigo?: string) => {
    const mot = motivoDeMensaje(crudo);
    if (!mot || visto.has(mot.texto)) return;
    visto.add(mot.texto);
    const sugerencia = mot.sugerencia ?? (codigo ? SUGERENCIAS_POR_CODIGO[codigo] : undefined);
    salida.push(sugerencia ? { ...mot, sugerencia } : mot);
  };

  const resp = doc.respuestaDian ?? {};
  const codigo = typeof resp.codigo === 'string' ? resp.codigo : undefined;
  const mensajes = Array.isArray(resp.mensajes) ? resp.mensajes : [];
  if (mensajes.length > 0) mensajes.forEach((m) => agregar(m, codigo));
  else if (doc.rechazoMotivo) String(doc.rechazoMotivo).split(';').forEach((m) => agregar(m, codigo));

  const sinRed = doc.ultimoIntentoSinRed ?? {};
  const motivosSinRed = Array.isArray(sinRed.motivos) ? sinRed.motivos : [];
  const codigoSinRed = typeof sinRed.codigo === 'string' ? sinRed.codigo : undefined;
  motivosSinRed.forEach((m) => agregar(m, codigoSinRed));

  return salida.slice(0, MAX_MOTIVOS);
}

/** Frase corta del estado DIAN para el encabezado del detalle. */
export function resumenEstado(dianStatus: string): string {
  switch (dianStatus) {
    case 'accepted':
      return 'Aceptado por la DIAN';
    case 'rejected':
      return 'Rechazado por la DIAN: corrige el motivo y reintenta con el mismo número';
    case 'sent':
      return 'Enviado a la DIAN, esperando el veredicto';
    case 'signed':
      return 'Firmado, pendiente de enviar a la DIAN';
    case 'contingency':
      return 'En contingencia';
    default:
      return 'Generado, pendiente de firmar y enviar';
  }
}
