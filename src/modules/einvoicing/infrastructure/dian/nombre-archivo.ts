import type { DocType } from '../../domain/einvoicing.constants';

/**
 * Nombre de los archivos que se envían a la DIAN (anexo técnico FEV 1.9,
 * «nombre de los archivos»):
 *
 *   <prefijo><NIT 10 dígitos><código PT 3 dígitos><año 2 dígitos><consecutivo hex 8 dígitos>
 *
 * `z` para el ZIP y el prefijo del tipo para el XML de adentro. El código del
 * proveedor tecnológico es `000` cuando el software es propio. El documento
 * equivalente POS usa `ds` (anexo DE v1.0 §8.13.5). POR CONFIRMAR en
 * habilitación: si la DIAN exige que el consecutivo de archivo sea el de la
 * factura o uno propio por año.
 */
export const PREFIJO_ARCHIVO: Readonly<Record<DocType, string>> = {
  invoice: 'fv',
  pos: 'ds',
  credit_note: 'nc',
  debit_note: 'nd',
  payroll: 'nie',
  payroll_adjustment: 'niae',
};

export const CODIGO_PT_SOFTWARE_PROPIO = '000';

export interface DatosNombreArchivo {
  tipo: DocType;
  /** NIT del emisor sin dígito de verificación. */
  nit: string;
  /** Consecutivo del archivo (entero ≥ 0, cabe en 8 dígitos hex). */
  consecutivo: number;
  /** Año (4 dígitos) del envío. */
  anio: number;
  codigoPt?: string;
}

export interface NombresArchivo {
  xml: string;
  zip: string;
}

function cuerpo(d: DatosNombreArchivo): string {
  const nit = d.nit.replace(/\D/g, '');
  if (nit.length === 0 || nit.length > 10) throw new Error('NIT inválido para el nombre de archivo');
  const pt = d.codigoPt ?? CODIGO_PT_SOFTWARE_PROPIO;
  if (!/^\d{3}$/.test(pt)) throw new Error('Código de proveedor tecnológico inválido');
  if (!Number.isSafeInteger(d.consecutivo) || d.consecutivo < 0 || d.consecutivo > 0xffffffff) {
    throw new Error('Consecutivo de archivo fuera de rango');
  }
  if (!Number.isInteger(d.anio) || d.anio < 2000 || d.anio > 2099) throw new Error('Año inválido');
  const anio = String(d.anio % 100).padStart(2, '0');
  const hex = d.consecutivo.toString(16).padStart(8, '0');
  return `${nit.padStart(10, '0')}${pt}${anio}${hex}`;
}

/** Nombres del XML y del ZIP de un envío. */
export function nombresArchivo(d: DatosNombreArchivo): NombresArchivo {
  const c = cuerpo(d);
  return { xml: `${PREFIJO_ARCHIVO[d.tipo]}${c}.xml`, zip: `z${c}.zip` };
}

export interface NombresEntrega extends NombresArchivo {
  pdf: string;
}

/**
 * Nombres de la entrega al adquiriente (anexo FEV 1.9): el AttachedDocument
 * `ad….xml` y su representación gráfica `ad….pdf`, dentro de `z….zip`.
 */
export function nombresEntrega(d: Omit<DatosNombreArchivo, 'tipo'>): NombresEntrega {
  const c = cuerpo({ ...d, tipo: 'invoice' });
  return { xml: `ad${c}.xml`, pdf: `ad${c}.pdf`, zip: `z${c}.zip` };
}

/**
 * Consecutivo del archivo sacado del número completo del documento
 * (`SETP990000001` → 990000001). Si no trae dígitos, lanza.
 */
export function consecutivoDeNumero(fullNumber: string): number {
  const m = /(\d+)$/.exec(fullNumber.trim());
  if (!m) throw new Error('El número del documento no termina en dígitos');
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n > 0xffffffff) throw new Error('Consecutivo de archivo fuera de rango');
  return n;
}

/** Año calendario en Colombia (UTC-5, sin horario de verano). */
export function anioColombia(ahora: Date): number {
  return new Date(ahora.getTime() - 5 * 3_600_000).getUTCFullYear();
}
