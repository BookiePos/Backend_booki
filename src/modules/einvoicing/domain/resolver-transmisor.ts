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

/**
 * Elige el transmisor del emisor. Nunca hay credencial global por env: si falta
 * el .p12 vigente, el SoftwareID o el PIN, devuelve el stub con
 * `CONFIG_FALTANTE` y nada sale a la red. La implementación directa llega en
 * las Fases 3-4; hasta entonces incluso un emisor completo recibe el stub.
 */
export function resolverTransmisor(emisor: EmisorTransmision): TransmisorDian {
  const faltantes: string[] = [];
  if (!emisor.certificadoVigente) faltantes.push('certificado .p12 vigente');
  if (!emisor.softwareId?.trim()) faltantes.push('SoftwareID');
  if (!emisor.tienePin) faltantes.push('PIN del software');
  if (faltantes.length > 0) {
    return new StubDian(`Falta configurar: ${faltantes.join(', ')}`);
  }
  // Fases 3-4: devolver DirectoDian cuando exista.
  return new StubDian('Transmisión directa a la DIAN aún no implementada');
}
