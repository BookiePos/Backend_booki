import { XMLParser } from 'fast-xml-parser';

/** Namespace UBL de la raíz de una ApplicationResponse de la DIAN. */
export const NS_APPLICATION_RESPONSE = 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2';

type Nodo = Record<string, unknown>;

// Sin `removeNSPrefix` para poder leer el `xmlns` de la raíz; los comentarios no
// llegan al árbol (por defecto se ignoran) y no hay entidades.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

function nodo(v: unknown): Nodo | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Nodo) : undefined;
}

/** Hijos con ese nombre local (cualquier prefijo). El primero basta: lo demás no se lee. */
function hijo(n: Nodo | undefined, local: string): unknown {
  if (!n) return undefined;
  for (const [clave, valor] of Object.entries(n)) {
    if (clave.startsWith('@_') || clave.startsWith('#')) continue;
    if (clave.split(':').pop() === local) return Array.isArray(valor) ? valor[0] : valor;
  }
  return undefined;
}

function texto(v: unknown): string | undefined {
  const t = typeof v === 'string' ? v : nodo(v) && typeof nodo(v)!['#text'] === 'string' ? (nodo(v)!['#text'] as string) : undefined;
  const limpio = t?.trim();
  return limpio || undefined;
}

/**
 * Código de respuesta y CUFE referenciado de una ApplicationResponse, leídos del
 * ÁRBOL del XML (no con regex sobre el texto: serían cuadráticas y verían
 * comentarios). Exige raíz única `ApplicationResponse` en el namespace UBL.
 * `null` si no es una ApplicationResponse legible.
 */
export function leerApplicationResponseXml(xml: string): { codigo: string; cufe: string } | null {
  let raiz: Nodo;
  try {
    raiz = parser.parse(xml) as Nodo;
  } catch {
    return null;
  }
  const claves = Object.keys(raiz).filter((k) => k !== '#text' && k !== '#comment');
  if (claves.length !== 1) return null;
  const m = /^(?:([A-Za-z_][\w.-]*):)?ApplicationResponse$/.exec(claves[0]!);
  if (!m) return null;
  const ar = nodo(raiz[claves[0]!]);
  if (!ar) return null;
  const ns = m[1] ? ar[`@_xmlns:${m[1]}`] : ar['@_xmlns'];
  if (ns !== NS_APPLICATION_RESPONSE) return null;
  const respuesta = nodo(hijo(ar, 'DocumentResponse'));
  const codigo = texto(hijo(nodo(hijo(respuesta, 'Response')), 'ResponseCode'));
  const cufe = texto(hijo(nodo(hijo(respuesta, 'DocumentReference')), 'UUID'));
  return codigo && cufe ? { codigo, cufe } : null;
}
