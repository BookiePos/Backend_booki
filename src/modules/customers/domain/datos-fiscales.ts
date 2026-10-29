/**
 * Datos fiscales del cliente para ser adquiriente de una factura electrónica
 * (Anexo técnico FEV 1.9 de la DIAN). Funciones puras, sin Nest ni Mongo.
 */

/**
 * Tipos de documento del adquiriente (código DIAN -> nombre). Tabla «Tipos de
 * documento de identificación» del anexo FEV 1.9.
 */
export const DIAN_DOC_TYPES = {
  '11': 'Registro civil',
  '12': 'Tarjeta de identidad',
  '13': 'Cédula de ciudadanía',
  '21': 'Tarjeta de extranjería',
  '22': 'Cédula de extranjería',
  '31': 'NIT',
  '41': 'Pasaporte',
  '42': 'Documento de identificación extranjero',
  '47': 'PEP (Permiso Especial de Permanencia)',
  '48': 'PPT (Permiso por Protección Temporal)',
  '50': 'NIT de otro país',
  '91': 'NUIP',
} as const;
export type DianDocTypeCode = keyof typeof DIAN_DOC_TYPES;
export const DIAN_DOC_TYPE_CODES = Object.keys(
  DIAN_DOC_TYPES,
) as DianDocTypeCode[];

/** Tipo de persona (código DIAN): 1 jurídica, 2 natural. */
export const TIPOS_PERSONA = ['1', '2'] as const;
export type TipoPersona = (typeof TIPOS_PERSONA)[number];

/** Responsabilidades fiscales del RUT que admite el adquiriente. */
export const RESPONSABILIDADES_FISCALES = [
  'O-13', // gran contribuyente
  'O-15', // autorretenedor
  'O-23', // agente de retención IVA
  'O-47', // régimen simple de tributación
  'R-99-PN', // no responsable
] as const;
export type ResponsabilidadFiscal = (typeof RESPONSABILIDADES_FISCALES)[number];

/** Régimen del adquiriente: responsable de IVA o no responsable. */
export const REGIMENES = ['responsable_iva', 'no_responsable_iva'] as const;
export type Regimen = (typeof REGIMENES)[number];

/** Equivalencia con el `docType` histórico del cliente (solo orientativa). */
export const DOC_TYPE_LEGADO_A_DIAN: Record<string, DianDocTypeCode> = {
  CC: '13',
  NIT: '31',
  CE: '22',
  PAS: '41',
};

/** Tipos cuyo número son solo dígitos, sin ceros a la izquierda. */
export const DOC_TYPES_NUMERICOS = ['11', '12', '13', '91'];

/**
 * Número de documento como lo espera la DIAN: en 11, 12, 13 y 91 solo dígitos y
 * sin ceros a la izquierda; los demás (extranjeros) conservan letras.
 */
export function normalizarNumeroDocumento(
  dianDocType: string,
  numero: string,
): string {
  const t = numero.replace(/\s/g, '');
  if (!DOC_TYPES_NUMERICOS.includes(dianDocType)) return t;
  return t.replace(/\D/g, '').replace(/^0+/, '');
}

const PESOS_DV = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/**
 * Dígito de verificación del NIT (módulo 11 de la DIAN). Los pesos se aplican
 * de derecha a izquierda sobre los dígitos del NIT base, sin DV. Devuelve
 * undefined si el NIT no son solo dígitos o pasa de 15.
 */
export function calcularDvNit(nitBase: string): number | undefined {
  const digitos = String(nitBase).trim();
  if (!/^\d{1,15}$/.test(digitos)) return undefined;
  let suma = 0;
  for (let i = 0; i < digitos.length; i++) {
    suma += Number(digitos[digitos.length - 1 - i]) * PESOS_DV[i]!;
  }
  const resto = suma % 11;
  return resto > 1 ? 11 - resto : resto;
}

/** True si `dv` es el DV correcto del NIT base. */
export function dvNitValido(nitBase: string, dv: string | number): boolean {
  const esperado = calcularDvNit(nitBase);
  return esperado !== undefined && String(dv).trim() === String(esperado);
}

/**
 * Separa un NIT escrito como '900.123.456-7' en base y DV. Sin guion no hay
 * DV que separar (un NIT de 10 dígitos pegado es ambiguo): devuelve solo la base.
 */
export function separarNitConDv(
  texto?: string | null,
): { base: string; dv?: string } | undefined {
  if (!texto) return undefined;
  const partes = String(texto).trim().split('-');
  const base = (partes[0] ?? '').replace(/\D/g, '');
  if (!base) return undefined;
  if (partes.length === 2) {
    const dv = (partes[1] ?? '').replace(/\D/g, '');
    return dv ? { base, dv } : { base };
  }
  return { base };
}

/**
 * Valida el DV de un cliente con NIT. Devuelve el mensaje de error (que dice
 * qué campo corregir) o undefined si está bien o no aplica.
 *
 * Un NIT del formato histórico (`docType` NIT, sin tipo DIAN) sin DV no se
 * rechaza: no se puede romper lo que ya existe.
 */
export function errorDvCliente(c: {
  dianDocType?: string;
  docType?: string;
  docNumber?: string;
  nitDv?: string;
}): string | undefined {
  const esNit = c.dianDocType ? c.dianDocType === '31' : c.docType === 'NIT';
  if (!esNit) return undefined;
  const nit = separarNitConDv(c.docNumber);
  const dv = c.nitDv?.trim() || nit?.dv;
  if (!nit || !dv) {
    return c.dianDocType === '31'
      ? 'Falta el dígito de verificación (DV) del NIT: complétalo en el campo «DV».'
      : undefined;
  }
  const esperado = calcularDvNit(nit.base);
  if (esperado === undefined) {
    return 'El número de documento del NIT solo debe tener dígitos: corrige el campo «Número de documento».';
  }
  if (String(esperado) !== dv) {
    return `El DV del NIT ${nit.base} no cuadra: debería ser ${esperado}, no ${dv}. Corrige el campo «DV» (o el «Número de documento» si el NIT está mal).`;
  }
  return undefined;
}

/**
 * Propuesta de tipo DIAN para un cliente viejo, solo cuando es inequívoca:
 * `docType` NIT con el número escrito con guion y el DV del guion cuadrando.
 */
export function proponerTipoDian(c: {
  docType?: string;
  docNumber?: string;
}): { dianDocType: '31'; nitDv: string } | undefined {
  if (c.docType !== 'NIT' || !c.docNumber?.includes('-')) return undefined;
  const nit = separarNitConDv(c.docNumber);
  if (!nit?.dv || String(calcularDvNit(nit.base)) !== nit.dv) return undefined;
  return { dianDocType: '31', nitDv: nit.dv };
}
