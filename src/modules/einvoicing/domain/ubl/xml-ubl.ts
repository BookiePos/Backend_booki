import { aCentavos, centavosDeCop, formatearMontoDian, type Centavos } from '../redondeo';

/**
 * Piezas de texto del XML UBL 2.1 (anexo FEV 1.9). Todo lo que es dinero pasa
 * por `formatearMontoDian` (el único lugar que arma `0.00`, ver `redondeo.ts`).
 */

/** El documento no se puede armar: no cuadra, le faltan datos o trae algo inválido. */
export class DocumentoUblInvalidoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'DocumentoUblInvalidoError';
  }
}

/**
 * Caracteres que XML 1.0 no admite ni escapados (§2.2): controles C0 salvo
 * tab, salto de línea y retorno de carro, y U+FFFE/U+FFFF. Un texto así no se
 * limpia en silencio (el XML firmado diría otra cosa que el documento): se
 * rechaza antes de firmar.
 */
function tieneCaracterNoXml(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff) return true;
  }
  return false;
}

/**
 * Recorre los textos de un valor y lanza si alguno trae un carácter que XML
 * no admite. `ruta` dice dónde (p. ej. `lineas[0].description`); el texto no
 * se cita.
 */
export function assertTextoXml(valor: unknown, ruta: string): void {
  if (typeof valor === 'string') {
    if (tieneCaracterNoXml(valor)) {
      throw new DocumentoUblInvalidoError(
        `${ruta} trae un carácter de control que la factura electrónica no admite: corrígelo en el dato de origen.`,
      );
    }
    return;
  }
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => assertTextoXml(v, `${ruta}[${i}]`));
    return;
  }
  if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
    for (const [k, v] of Object.entries(valor)) assertTextoXml(v, ruta ? `${ruta}.${k}` : k);
  }
}

/**
 * Escape de CONTENIDO de texto: solo `& < >`. Comillas y apóstrofos son válidos
 * en contenido y escaparlos cambia el texto canónico que firma la XAdES. Un
 * carácter que XML no admite lanza (defensa: `prepararFacturaUbl` ya lo
 * rechazó diciendo en qué campo).
 */
export function esc(s: string): string {
  assertTextoXml(s, 'Un texto del documento');
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** Pesos enteros del documento → centavos. Un monto con fracción no se redondea en silencio: se rechaza. */
export function centavos(pesos: number | undefined, que: string): Centavos {
  if (pesos === undefined || !Number.isSafeInteger(pesos) || pesos < 0) {
    throw new DocumentoUblInvalidoError(`${que}: se esperaban pesos enteros no negativos y llegó ${String(pesos)}`);
  }
  return centavosDeCop(pesos);
}

/** `currencyID="COP"` + monto con dos decimales. */
export function monto(c: Centavos): string {
  return `currencyID="COP">${formatearMontoDian(c)}`;
}

/** Tarifa en porcentaje (19, 8, 0) → `19.00`. */
export function porcentaje(tarifa: number): string {
  if (!(tarifa >= 0) || tarifa > 100) throw new DocumentoUblInvalidoError(`Tarifa inválida: ${tarifa}`);
  return formatearMontoDian(aCentavos(tarifa));
}

/**
 * Cantidad con 2 a 6 decimales: 2 → `2.00`, 0.125 → `0.125`. Cantidad, no
 * dinero: no pasa por el redondeo de montos.
 */
export function cantidad(n: number): string {
  if (!Number.isFinite(n) || n <= 0) throw new DocumentoUblInvalidoError(`Cantidad inválida: ${n}`);
  const s = String(Number(n.toPrecision(12)));
  const [entero, dec = ''] = s.split('.');
  if (!/^\d+$/.test(entero ?? '') || dec.length > 6) {
    throw new DocumentoUblInvalidoError(`Cantidad con más de 6 decimales: ${n}`);
  }
  return `${entero}.${dec.padEnd(2, '0')}`;
}

/** Código de unidad (tabla de unidades DIAN, p. ej. `94`): va en un atributo, así que solo alfanumérico. */
export function codigoUnidad(u: string | undefined): string {
  const v = (u ?? '').trim() || '94';
  if (!/^[A-Za-z0-9]{1,5}$/.test(v)) throw new DocumentoUblInvalidoError(`Unidad de medida inválida: «${v}»`);
  return v;
}

/** Agencia DIAN de los identificadores (CompanyID, ProviderID…). */
export const AGENCIA_DIAN =
  'schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"';

/** Atributos de la lista de países (ISO 3166-1, UN/ECE). */
export const LISTA_PAISES =
  'listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1"';

/**
 * Departamentos por los dos primeros dígitos del código DANE (DIVIPOLA). El
 * `CountrySubentity` sale de aquí y no de un texto libre, así coincide siempre
 * con el municipio.
 */
export const DEPARTAMENTOS_DANE: Record<string, string> = {
  '05': 'Antioquia',
  '08': 'Atlántico',
  '11': 'Bogotá, D.C.',
  '13': 'Bolívar',
  '15': 'Boyacá',
  '17': 'Caldas',
  '18': 'Caquetá',
  '19': 'Cauca',
  '20': 'Cesar',
  '23': 'Córdoba',
  '25': 'Cundinamarca',
  '27': 'Chocó',
  '41': 'Huila',
  '44': 'La Guajira',
  '47': 'Magdalena',
  '50': 'Meta',
  '52': 'Nariño',
  '54': 'Norte de Santander',
  '63': 'Quindío',
  '66': 'Risaralda',
  '68': 'Santander',
  '70': 'Sucre',
  '73': 'Tolima',
  '76': 'Valle del Cauca',
  '81': 'Arauca',
  '85': 'Casanare',
  '86': 'Putumayo',
  '88': 'Archipiélago de San Andrés, Providencia y Santa Catalina',
  '91': 'Amazonas',
  '94': 'Guainía',
  '95': 'Guaviare',
  '97': 'Vaupés',
  '99': 'Vichada',
};

/** ¿Es un código DANE de municipio con un departamento conocido? */
export function municipioDaneValido(dane: string | undefined): dane is string {
  return /^\d{5}$/.test(dane ?? '') && (dane ?? '').slice(0, 2) in DEPARTAMENTOS_DANE;
}
