/**
 * Validación XSD local del XML UBL 2.1 de la DIAN. SOLO para tests: usa la
 * devDependency `xmllint-wasm` (libxml2 compilado a wasm, sin red) y los XSD
 * oficiales de `xsd/` (ver su README con la fuente y los SHA-256).
 *
 * `ext:ExtensionContent` es `processContents="lax"` y libxml2 no valida el
 * contenido lax aunque el esquema esté cargado (un hijo inventado dentro de
 * `sts:DianExtensions` pasaría). Por eso `sts:DianExtensions` se valida APARTE,
 * como raíz, contra `DIAN_UBL_Structures.xsd`.
 *
 * Se ignora UNA faceta desactualizada del XSD (igual que AlíaCorp):
 * `coID2Type/@schemeID` enumera tipos de documento, pero el anexo pide ahí el DV
 * (`ProviderID schemeID="4" schemeName="31"`) y el propio ejemplo oficial
 * `Generica.xml` la incumple. Nada más se ignora.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateXML, type XMLFileInfo } from 'xmllint-wasm';

const DIR = join(__dirname, 'xsd');

const NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const NS_STS = 'dian:gov:co:facturaelectronica:Structures-2-1';

const ENVOLTORIO = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:import namespace="${NS_INVOICE}" schemaLocation="maindoc/UBL-Invoice-2.1.xsd"/>
  <xsd:import namespace="${NS_STS}" schemaLocation="maindoc/DIAN_UBL_Structures.xsd"/>
</xsd:schema>`;

let esquemas: XMLFileInfo[] | null = null;
function cargarEsquemas(): XMLFileInfo[] {
  esquemas ??= (['common', 'maindoc'] as const).flatMap((carpeta) =>
    readdirSync(join(DIR, carpeta))
      .filter((f) => f.endsWith('.xsd'))
      .map((f) => ({ fileName: `${carpeta}/${f}`, contents: readFileSync(join(DIR, carpeta, f), 'utf8') })),
  );
  return esquemas;
}

export interface ResultadoXsd {
  valido: boolean;
  errores: string[];
}

const NS_FRAGMENTO = [
  `xmlns:sts="${NS_STS}"`,
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
  'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
].join(' ');

/** `sts:DianExtensions` como documento propio (los prefijos se declaran en la raíz del original). */
export function fragmentoDianExtensions(xml: string): string | null {
  const m = xml.match(/<sts:DianExtensions[^>]*>[\s\S]*?<\/sts:DianExtensions>/);
  return m ? m[0].replace(/^<sts:DianExtensions[^>]*>/, `<sts:DianExtensions ${NS_FRAGMENTO}>`) : null;
}

const FACETA_DESACTUALIZADA =
  /Element '\{dian:gov:co:facturaelectronica:Structures-2-1\}(?:ProviderID|AuthorizationProviderID)', attribute 'schemeID': \[facet 'enumeration'\]/;

async function validar(xml: string, nombre: string): Promise<string[]> {
  const r = await validateXML({
    xml: { fileName: nombre, contents: xml },
    schema: { fileName: 'dian-ubl21.xsd', contents: ENVOLTORIO },
    preload: cargarEsquemas(),
    // El agregado común de UBL pesa 2,4 MB: con la memoria por defecto no compila.
    initialMemoryPages: 2048,
    maxMemoryPages: 8192,
  });
  return r.valid ? [] : r.errors.map((e) => e.message).filter((m) => !FACETA_DESACTUALIZADA.test(m));
}

/** Valida un XML UBL 2.1 (y su `sts:DianExtensions`) contra los XSD oficiales. Nunca sale a la red. */
export async function validarXsdDian(xml: string, nombre = 'documento.xml'): Promise<ResultadoXsd> {
  const ext = fragmentoDianExtensions(xml);
  const errores = [...(await validar(xml, nombre)), ...(ext ? await validar(ext, `ext-${nombre}`) : [])];
  return { valido: errores.length === 0, errores };
}

export function leerEjemploDian(nombre: string): string {
  return readFileSync(join(DIR, 'ejemplos-dian', nombre), 'utf8');
}
