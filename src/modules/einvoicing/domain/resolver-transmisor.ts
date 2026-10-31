import { StubDian } from './stub-dian';
import type { TransmisorDian } from './transmisor-dian';

/** Lo mínimo del emisor que decide si se puede transmitir directo. */
export interface EmisorTransmision {
  /** .p12 cargado y dentro de su vigencia. */
  certificadoVigente: boolean;
  softwareId?: string;
  /** PIN del software cargado (no se pasa su valor aquí). */
  tienePin: boolean;
}

/** Lo que le falta al emisor para transmitir directo (vacío = nada). */
export function faltantesParaTransmitir(emisor: EmisorTransmision): string[] {
  const faltantes: string[] = [];
  if (!emisor.certificadoVigente) faltantes.push('certificado .p12 vigente');
  if (!emisor.softwareId?.trim()) faltantes.push('SoftwareID');
  if (!emisor.tienePin) faltantes.push('PIN del software');
  return faltantes;
}

export const MENSAJE_SIN_DIRECTO =
  'Falta configurar: la transmisión directa solo se arma con el ambiente decidido por el gate';

/**
 * Elige el transmisor del emisor. Nunca hay credencial global por env: si falta
 * el .p12 vigente, el SoftwareID o el PIN, devuelve el stub con
 * `CONFIG_FALTANTE` y nada sale a la red. El transmisor directo lo arma quien
 * tiene el material del .p12 y el ambiente del gate
 * (`ProveedorTransmisorPorEmisor`) y lo pasa como fábrica; sin fábrica, stub.
 * El dominio no conoce la implementación SOAP.
 */
export function resolverTransmisor(
  emisor: EmisorTransmision,
  crearDirecto?: () => TransmisorDian,
): TransmisorDian {
  const faltantes = faltantesParaTransmitir(emisor);
  if (faltantes.length > 0) {
    return new StubDian(`Falta configurar: ${faltantes.join(', ')}`);
  }
  if (!crearDirecto) return new StubDian(MENSAJE_SIN_DIRECTO);
  return crearDirecto();
}
