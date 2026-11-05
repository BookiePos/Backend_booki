import type { EmisionNe } from './modelo';

/** Lo que el emisor fiscal aporta como empleador de la nómina electrónica. */
export interface EmisorParaEmpleador {
  razonSocial?: string;
  nit: string;
  nitNorm: string;
  nitDv?: string;
  direccion?: string;
  municipioDane?: string;
}

export type ResultadoEmpleador =
  | { ok: true; empleador: EmisionNe['empleador'] }
  | { ok: false; motivos: string[] };

/**
 * Arma el empleador del documento desde el emisor. Falla cerrado: sin razón
 * social, DV, dirección o municipio DANE (5 dígitos) no se emite, porque el
 * XSD los exige y la DIAN rechazaría el documento después de gastar número.
 */
export function empleadorDeEmisor(e: EmisorParaEmpleador): ResultadoEmpleador {
  const motivos: string[] = [];
  const razonSocial = e.razonSocial?.trim();
  const direccion = e.direccion?.trim();
  const dv = e.nitDv?.trim();
  const municipio = e.municipioDane?.trim();
  if (!razonSocial) motivos.push('el emisor no tiene razón social');
  if (!dv) motivos.push('el emisor no tiene dígito de verificación del NIT');
  if (!direccion) motivos.push('el emisor no tiene dirección');
  if (!municipio || !/^\d{5}$/.test(municipio)) motivos.push('el emisor no tiene el código DANE del municipio (5 dígitos)');
  if (motivos.length > 0) return { ok: false, motivos };
  return {
    ok: true,
    empleador: {
      nit: e.nitNorm,
      dv: dv!,
      razonSocial: razonSocial!,
      departamento: municipio!.slice(0, 2),
      municipio: municipio!,
      direccion: direccion!,
    },
  };
}

/** Fecha y hora de Colombia (UTC-5, sin horario de verano) como las pide el XSD. */
export function relojColombia(d: Date = new Date()): { fecha: string; hora: string } {
  const local = new Date(d.getTime() - 5 * 3_600_000);
  const iso = local.toISOString();
  return { fecha: iso.slice(0, 10), hora: `${iso.slice(11, 19)}-05:00` };
}
