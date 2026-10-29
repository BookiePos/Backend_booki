import { normalizarNit } from './consecutivo-unico';
import type { EmisorTransmision } from './resolver-transmisor';

/**
 * Emisor fiscal (checklist 1, Fase 1): la configuración de factura electrónica
 * se ancla al NIT, no a la empresa ni a la sede, porque el .p12, el SoftwareID y
 * el PIN son por NIT. Aquí vive la lógica pura: qué datos de la sede pasan al
 * emisor, cuándo dos sedes con el mismo NIT no coinciden y qué le falta a un
 * emisor para transmitir. El esquema está en `fiscal-emitter.schema.ts` y el
 * acceso a la base en `FiscalEmittersService`.
 */

/** Ambiente DIAN: '1' producción, '2' habilitación (pruebas). */
export const TIPOS_AMBIENTE = ['1', '2'] as const;
export type TipoAmbiente = (typeof TIPOS_AMBIENTE)[number];
export const TIPO_AMBIENTE_POR_DEFECTO: TipoAmbiente = '2';

/**
 * Campos cifrados del emisor. El contexto del cifrado es SIEMPRE
 * `contextoSecreto(emisorId, campo)` con el nombre exacto del campo, así que
 * un valor copiado a otro emisor o a otro campo deja de descifrar.
 */
export const CAMPOS_SECRETOS_EMISOR = [
  'facturaPin',
  'nominaPin',
  'certPasswordCifrada',
] as const;
export type CampoSecretoEmisor = (typeof CAMPOS_SECRETOS_EMISOR)[number];

/** Lo mínimo de la sede que se lee para armar su emisor. */
export interface SedeFiscal {
  name?: string;
  businessName?: string;
  nit?: string;
  nitDv?: string;
  tipoPersona?: string;
  responsabilidadFiscal?: string;
  responsableIva?: boolean;
  responsableInc?: boolean;
  franquicia?: boolean;
  granContribuyente?: boolean;
  regimenRenta?: string;
  ciiu?: string;
  address?: string;
  departamento?: string;
  ciudad?: string;
  phone?: string;
  emailFacturacion?: string;
}

/** Datos fiscales del emisor, tal como se copian de la sede. */
export interface DatosEmisor {
  /** Igual que `buildEmisor`: nombre comercial o, sin él, el nombre de la sede. */
  razonSocial?: string;
  nit: string;
  nitNorm: string;
  nitDv?: string;
  tipoPersona?: string;
  responsabilidadFiscal?: string;
  responsableIva?: boolean;
  responsableInc?: boolean;
  franquicia?: boolean;
  granContribuyente?: boolean;
  regimenRenta?: string;
  ciiu?: string;
  direccion?: string;
  departamento?: string;
  ciudad?: string;
  telefono?: string;
  emailFacturacion?: string;
}

/**
 * Identidad fiscal: si dos sedes con el mismo NIT no coinciden en alguno de
 * estos, no se sabe cuál es el RUT real y la migración no elige.
 */
export const CAMPOS_IDENTIDAD_FISCAL = [
  'razonSocial',
  'nitDv',
  'tipoPersona',
  'responsabilidadFiscal',
  'responsableIva',
  'responsableInc',
  'franquicia',
  'granContribuyente',
  'regimenRenta',
  'ciiu',
] as const satisfies readonly (keyof DatosEmisor)[];

/**
 * Contacto y domicilio: dos sedes del mismo NIT pueden tener direcciones
 * distintas sin contradecirse. Si no coinciden, el emisor queda sin ese dato
 * (se completa a mano) en lugar de quedarse con el de una sede cualquiera.
 */
export const CAMPOS_CONTACTO = [
  'direccion',
  'departamento',
  'ciudad',
  'telefono',
  'emailFacturacion',
] as const satisfies readonly (keyof DatosEmisor)[];

const limpio = (v?: string): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** Datos del emisor a partir de una sede. `null` si la sede no tiene NIT utilizable. */
export function datosEmisorDeSede(sede: SedeFiscal): DatosEmisor | null {
  const nitNorm = normalizarNit(sede.nit);
  if (!nitNorm || !sede.nit) return null;
  return {
    razonSocial: limpio(sede.businessName) ?? limpio(sede.name),
    nit: sede.nit.trim(),
    nitNorm,
    nitDv: limpio(sede.nitDv),
    tipoPersona: sede.tipoPersona,
    responsabilidadFiscal: sede.responsabilidadFiscal,
    responsableIva: sede.responsableIva,
    responsableInc: sede.responsableInc,
    franquicia: sede.franquicia,
    granContribuyente: sede.granContribuyente,
    regimenRenta: sede.regimenRenta,
    ciiu: limpio(sede.ciiu),
    direccion: limpio(sede.address),
    departamento: limpio(sede.departamento),
    ciudad: limpio(sede.ciudad),
    telefono: limpio(sede.phone),
    emailFacturacion: limpio(sede.emailFacturacion)?.toLowerCase(),
  };
}

/** Compara sin que mayúsculas ni espacios cuenten como diferencia. */
function igual(a: unknown, b: unknown): boolean {
  const n = (v: unknown) =>
    typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : v ?? undefined;
  return n(a) === n(b);
}

/** Campos de identidad fiscal en los que difieren dos juegos de datos. */
export function diferenciasFiscales(
  a: Partial<DatosEmisor>,
  b: Partial<DatosEmisor>,
): string[] {
  return CAMPOS_IDENTIDAD_FISCAL.filter((c) => !igual(a[c], b[c]));
}

export type Fusion =
  | { ok: true; datos: DatosEmisor; contactoOmitido: string[] }
  | { ok: false; conflictos: string[] };

/**
 * Funde los datos de las sedes de un mismo NIT. Si discrepan en la identidad
 * fiscal devuelve los campos en conflicto y no elige. El contacto que no
 * coincide se deja vacío y se informa.
 */
export function fusionarDatosEmisor(lista: DatosEmisor[]): Fusion {
  const [primero, ...resto] = lista;
  if (!primero) return { ok: false, conflictos: ['sin sedes'] };
  const conflictos = new Set<string>();
  for (const otro of resto) {
    if (otro.nitNorm !== primero.nitNorm) conflictos.add('nitNorm');
    for (const c of diferenciasFiscales(primero, otro)) conflictos.add(c);
  }
  if (conflictos.size > 0) return { ok: false, conflictos: [...conflictos] };
  const datos: DatosEmisor = { ...primero };
  const contactoOmitido: string[] = [];
  for (const c of CAMPOS_CONTACTO) {
    if (resto.some((o) => !igual(o[c], primero[c]))) {
      delete datos[c];
      contactoOmitido.push(c);
    }
  }
  return { ok: true, datos, contactoOmitido };
}

/** Lo que el servicio sabe del emisor para decidir si está configurado. */
export interface EmisorParaEstado {
  razonSocial?: string;
  nitDv?: string;
  tipoPersona?: string;
  municipioDane?: string;
  direccion?: string;
  emailFacturacion?: string;
  facturaSoftwareId?: string;
  facturaTestSetId?: string;
  certPath?: string;
  certVenceAt?: Date;
  tipoAmbiente?: string;
  habilitado?: boolean;
  /** Presencia de los secretos; nunca su valor. */
  tieneFacturaPin: boolean;
  tieneCertPassword: boolean;
}

/** Qué le falta a un emisor para emitir. Alimenta `resolverTransmisor`. */
export interface EstadoConfiguracion extends EmisorTransmision {
  tipoAmbiente: TipoAmbiente;
  habilitado: boolean;
  /** Lo que impide transmitir (certificado, SoftwareID, PIN). */
  faltaParaTransmitir: string[];
  /** Datos fiscales vacíos que el XML de la DIAN va a pedir. */
  datosFiscalesFaltantes: string[];
  /** Sin TestSetId no se puede correr el set de pruebas de habilitación. */
  tieneTestSetId: boolean;
}

/**
 * El certificado está vigente si hay archivo, contraseña y una fecha de
 * vencimiento posterior a `ahora`. Sin fecha conocida no se da por vigente.
 */
export function certificadoVigente(e: EmisorParaEstado, ahora: Date): boolean {
  return (
    !!e.certPath?.trim() &&
    e.tieneCertPassword &&
    e.certVenceAt instanceof Date &&
    e.certVenceAt.getTime() > ahora.getTime()
  );
}

export function estadoDeEmisor(e: EmisorParaEstado, ahora: Date): EstadoConfiguracion {
  const vigente = certificadoVigente(e, ahora);
  const softwareId = e.facturaSoftwareId?.trim() || undefined;
  const faltaParaTransmitir: string[] = [];
  if (!vigente) faltaParaTransmitir.push('certificado .p12 vigente');
  if (!softwareId) faltaParaTransmitir.push('SoftwareID');
  if (!e.tieneFacturaPin) faltaParaTransmitir.push('PIN del software');
  const datosFiscalesFaltantes: string[] = [];
  if (!e.razonSocial?.trim()) datosFiscalesFaltantes.push('razón social');
  if (!e.nitDv?.trim()) datosFiscalesFaltantes.push('DV');
  if (!e.tipoPersona) datosFiscalesFaltantes.push('tipo de persona');
  if (!e.direccion?.trim()) datosFiscalesFaltantes.push('dirección');
  if (!e.municipioDane?.trim()) datosFiscalesFaltantes.push('municipio DANE');
  if (!e.emailFacturacion?.trim()) datosFiscalesFaltantes.push('correo de facturación');
  return {
    certificadoVigente: vigente,
    softwareId,
    tienePin: e.tieneFacturaPin,
    tipoAmbiente: e.tipoAmbiente === '1' ? '1' : TIPO_AMBIENTE_POR_DEFECTO,
    habilitado: e.habilitado === true,
    faltaParaTransmitir,
    datosFiscalesFaltantes,
    tieneTestSetId: !!e.facturaTestSetId?.trim(),
  };
}
