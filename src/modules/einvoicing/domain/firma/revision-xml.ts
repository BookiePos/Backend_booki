/**
 * Revisiones del texto XML antes de firmarlo o verificarlo. Son puras y no parsean
 * el documento: miran el marcado tal como llega.
 */

/** Tope del XML de entrada. Una factura UBL con cientos de líneas no llega a 1 MB. */
export const TAMANO_MAXIMO_XML = 5 * 1024 * 1024;

/** `<!DOCTYPE` abre entidades y DTD externas (XXE, «billion laughs»): nunca se acepta. */
export function traeDoctype(xml: string): boolean {
  return /<!DOCTYPE/i.test(xml);
}

/**
 * Nombre del primer atributo cuyo valor trae un tab, un salto de línea o un retorno
 * de carro escrito tal cual, o `null` si no hay ninguno.
 *
 * Decisión: RECHAZAR, no normalizar. Al parsear, XML convierte esos caracteres en
 * espacios (XML 1.0 §3.3.3), así que el documento firmado ya no diría lo que el
 * armador escribió, y un validador que reciba el texto original sin parsearlo de la
 * misma forma calcularía otro digest. En UBL los atributos son códigos
 * (`schemeID`, `currencyID`, `listName`…), que nunca deberían traer esos
 * caracteres. Si los traen, es un error del armador y conviene que salga a la luz,
 * no que se tape. Los mismos caracteres escritos como referencia (`&#9;`) también
 * se rechazan: la revisión sobre el DOM está en la firma.
 *
 * Recorre solo el marcado: se salta texto, comentarios, CDATA e instrucciones de
 * procesamiento, y respeta las comillas dentro de la etiqueta.
 */
export function atributoConControl(xml: string): string | null {
  let i = 0;
  while ((i = xml.indexOf('<', i)) !== -1) {
    if (xml.startsWith('<!--', i)) {
      i = saltar(xml, i, '-->');
    } else if (xml.startsWith('<![CDATA[', i)) {
      i = saltar(xml, i, ']]>');
    } else if (xml.startsWith('<?', i)) {
      i = saltar(xml, i, '?>');
    } else if (xml[i + 1] === '/' || xml[i + 1] === '!') {
      i = saltar(xml, i, '>');
    } else {
      // Etiqueta de apertura: nombre=valor entre comillas, hasta el `>` de cierre.
      let j = i + 1;
      let nombre = '';
      let leyendoNombre = '';
      while (j < xml.length && xml[j] !== '>') {
        const c = xml[j]!;
        if (c === '"' || c === "'") {
          const fin = xml.indexOf(c, j + 1);
          if (fin === -1) return null; // mal formado: lo rechazará el parser
          if (/[\t\n\r]/.test(xml.slice(j + 1, fin))) return nombre || '(sin nombre)';
          j = fin + 1;
          leyendoNombre = '';
          continue;
        }
        if (c === '=') {
          nombre = leyendoNombre.trim().split(/\s+/).pop() ?? '';
        } else {
          leyendoNombre += c;
        }
        j += 1;
      }
      i = j + 1;
    }
  }
  return null;
}

function saltar(xml: string, desde: number, cierre: string): number {
  const fin = xml.indexOf(cierre, desde);
  return fin === -1 ? xml.length : fin + cierre.length;
}
