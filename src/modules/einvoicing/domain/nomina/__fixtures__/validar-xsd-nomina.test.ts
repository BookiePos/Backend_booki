/**
 * Validación XSD local de la nómina electrónica (NominaIndividual 102 y
 * NominaIndividualDeAjuste 103) contra los XSD oficiales 1.0.6 de `xsd/`. SOLO
 * para tests; usa `xmllint-wasm` y nunca sale a la red.
 *
 * Los XSD de nómina importan `../common/UBL-CommonExtensionComponents-2.1.xsd`,
 * el mismo archivo que ya usa la factura: se precarga desde
 * `ubl/__fixtures__/xsd/common` con el nombre `common/…`, de modo que la ruta
 * relativa resuelva desde `nomina/`. libxml2 no valida el contenido `lax` de
 * `ext:ExtensionContent` (la firma); las reglas NIE/NIAE tampoco están en el XSD.
 *
 * Se ignora UN error, el del slot de firma vacío: el XSD exige un hijo dentro de
 * `ext:UBLExtensions` / `ext:ExtensionContent`, pero antes de firmar va vacío (el
 * propio ejemplo oficial trae `ext:UBLExtensions` vacío y lo incumple). La firma
 * XAdES lo llena después. Nada más se ignora.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateXML, type XMLFileInfo } from 'xmllint-wasm';

const DIR = join(__dirname, 'xsd');
const COMUNES = join(__dirname, '..', '..', 'ubl', '__fixtures__', 'xsd', 'common');

const ESQUEMAS = {
  NominaIndividual: 'NominaIndividualElectronicaXSDV1.0.6.xsd',
  NominaIndividualDeAjuste: 'NominaIndividualDeAjusteElectronicaXSDV1.0.6.xsd',
} as const;

let comunes: XMLFileInfo[] | null = null;
function cargarComunes(): XMLFileInfo[] {
  comunes ??= readdirSync(COMUNES)
    .filter((f) => f.endsWith('.xsd'))
    .map((f) => ({ fileName: `common/${f}`, contents: readFileSync(join(COMUNES, f), 'utf8') }));
  return comunes;
}

const SLOT_DE_FIRMA_VACIO =
  /Element '\{urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2\}(?:UBLExtensions|ExtensionContent)': Missing child element/;

export interface ResultadoXsdNomina {
  valido: boolean;
  errores: string[];
}

/** Valida un XML de nómina (raíz NominaIndividual o NominaIndividualDeAjuste) contra el XSD oficial 1.0.6. */
export async function validarXsdNomina(xml: string, nombre = 'nomina.xml'): Promise<ResultadoXsdNomina> {
  const raiz = xml.match(/<(?![?!])(?:[\w.-]+:)?([\w.-]+)/)?.[1] ?? '';
  const esquema = ESQUEMAS[raiz as keyof typeof ESQUEMAS];
  if (!esquema) return { valido: false, errores: [`Raíz desconocida para nómina: «${raiz}»`] };
  const r = await validateXML({
    xml: { fileName: nombre, contents: xml },
    schema: { fileName: `nomina/${esquema}`, contents: readFileSync(join(DIR, esquema), 'utf8') },
    preload: cargarComunes(),
    initialMemoryPages: 2048,
    maxMemoryPages: 8192,
  });
  const errores = r.valid ? [] : r.errors.map((e) => e.message.trim()).filter((m) => !SLOT_DE_FIRMA_VACIO.test(m));
  return { valido: errores.length === 0, errores };
}

export function leerEjemploNomina(nombre: string): string {
  const s = readFileSync(join(DIR, 'ejemplos', nombre), 'utf8');
  // El ejemplo oficial trae BOM; se quita para que el XML empiece en la declaración.
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
