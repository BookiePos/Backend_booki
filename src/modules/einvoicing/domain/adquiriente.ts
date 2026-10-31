import {
  DIAN_DOC_TYPES,
  DOC_TYPES_NUMERICOS,
  RESPONSABILIDADES_FISCALES,
  errorDvCliente,
  normalizarNumeroDocumento,
  separarNitConDv,
} from '../../customers/domain/datos-fiscales';
import { CONSUMIDOR_FINAL_NIT } from './einvoicing.constants';

/**
 * Datos del cliente tal como viajan en la venta (copia congelada al vender).
 * `docType` es el código DIAN capturado en la ficha del cliente; sin él, un
 * número suelto NO se interpreta (antes se adivinaba por el largo).
 */
export interface ClienteVenta {
  name?: string;
  idNumber?: string;
  phone?: string;
  email?: string;
  docType?: string;
  nitDv?: string;
  tipoPersona?: string;
  responsabilidades?: string[];
  regimen?: string;
  municipioDane?: string;
  address?: string;
  emailFacturacion?: string;
}

export interface Adquiriente {
  docType: string;
  docNumber: string;
  name: string;
  nitDv?: string;
  tipoPersona?: string;
  responsabilidades?: string[];
  regimen?: string;
  municipioDane?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export const CONSUMIDOR_FINAL: Adquiriente = {
  docType: '13',
  docNumber: CONSUMIDOR_FINAL_NIT,
  name: 'Consumidor final',
  tipoPersona: '2',
  responsabilidades: ['R-99-PN'],
};

/** ¿La venta identifica de verdad al adquiriente (tipo DIAN conocido y número)? */
function identificado(c?: ClienteVenta): c is ClienteVenta & {
  idNumber: string;
  docType: string;
} {
  return Boolean(
    c?.idNumber?.replace(/\s/g, '') && c.docType && c.docType in DIAN_DOC_TYPES,
  );
}

/**
 * Adquiriente del documento a partir de lo capturado del cliente.
 *
 * Sin cliente, sin número o sin tipo de documento DIAN: consumidor final
 * (222222222222, tipo 13, R-99-PN). Un número sin tipo no se adivina: para el
 * POS va como consumidor final; la factura con datos lo rechaza antes con
 * `validarAdquirienteParaFactura`.
 */
export function buildAdquiriente(c?: ClienteVenta): Adquiriente {
  if (!identificado(c)) return { ...CONSUMIDOR_FINAL };
  const esNit = c.docType === '31';
  const nit = esNit ? separarNitConDv(c.idNumber) : undefined;
  return {
    docType: c.docType,
    docNumber:
      esNit && nit ? nit.base : normalizarNumeroDocumento(c.docType, c.idNumber),
    name: c.name?.trim() || 'Consumidor final',
    nitDv: esNit ? c.nitDv?.trim() || nit?.dv : undefined,
    tipoPersona: c.tipoPersona,
    responsabilidades: c.responsabilidades?.length
      ? c.responsabilidades
      : undefined,
    regimen: c.regimen,
    municipioDane: c.municipioDane,
    address: c.address,
    phone: c.phone,
    email: c.emailFacturacion || c.email,
  };
}

export interface ValidacionAdquiriente {
  /** La venta no trae un adquiriente identificado: saldría como consumidor final. */
  esConsumidorFinal: boolean;
  /** Qué hay que completar o corregir, en lenguaje de la ficha del cliente. */
  faltantes: string[];
}

/**
 * Qué falta para emitir una factura electrónica de venta CON datos del
 * adquiriente. La usará la emisión de la FEV; el POS no la exige.
 */
export function validarAdquirienteParaFactura(
  c?: ClienteVenta,
): ValidacionAdquiriente {
  if (!c || !c.idNumber?.replace(/\s/g, '')) {
    return {
      esConsumidorFinal: true,
      faltantes: ['número de documento', 'tipo de documento'],
    };
  }
  const faltantes: string[] = [];
  if (!c.docType || !(c.docType in DIAN_DOC_TYPES)) {
    faltantes.push('tipo de documento');
  }
  if (
    c.docType &&
    DOC_TYPES_NUMERICOS.includes(c.docType) &&
    !normalizarNumeroDocumento(c.docType, c.idNumber)
  ) {
    faltantes.push('número de documento (solo dígitos, sin ceros a la izquierda)');
  }
  if (!c.name?.trim()) faltantes.push('nombre o razón social');
  if (c.docType === '31') {
    const dvMsg = errorDvCliente({
      dianDocType: '31',
      docNumber: c.idNumber,
      nitDv: c.nitDv,
    });
    if (dvMsg) faltantes.push(dvMsg);
  }
  if (c.tipoPersona !== '1' && c.tipoPersona !== '2') {
    faltantes.push('tipo de persona');
  }
  const resp = c.responsabilidades ?? [];
  if (
    resp.length === 0 ||
    resp.some(
      (r) => !(RESPONSABILIDADES_FISCALES as readonly string[]).includes(r),
    )
  ) {
    faltantes.push('responsabilidades fiscales');
  }
  if (!/^\d{5}$/.test(c.municipioDane ?? '')) {
    faltantes.push('municipio (código DANE de 5 dígitos)');
  }
  if (!c.address?.trim()) faltantes.push('dirección');
  if (!(c.emailFacturacion || c.email)?.trim()) {
    faltantes.push('correo de facturación');
  }
  return { esConsumidorFinal: false, faltantes };
}

/** Adquiriente del POS, o lo que falta para el modo identificado. */
export interface AdquirientePos {
  adquiriente?: Adquiriente;
  faltantes: string[];
}

/**
 * Adquiriente del documento equivalente POS (D1 y D3 del anexo de la Fase 7).
 *
 * - `anonimo`: consumidor final (222222222222, tipo 13, R-99-PN) siempre, aunque
 *   la venta traiga datos del cliente: es la salida por defecto de la caja.
 * - `identificado`: el cliente pidió el POS con sus datos para soportar costos
 *   (art. 19 par. 1 Res. 165/2023). Bastan nombre, tipo y número de documento,
 *   y el DV si es NIT; NO se exige la ficha fiscal completa de la FEV
 *   (`validarAdquirienteParaFactura` no aplica). Si algo falta, no se inventa
 *   un consumidor final: se devuelve qué falta.
 */
export function adquirientePos(
  c: ClienteVenta | undefined,
  modo: 'anonimo' | 'identificado',
): AdquirientePos {
  if (modo === 'anonimo') return { adquiriente: { ...CONSUMIDOR_FINAL }, faltantes: [] };

  const faltantes: string[] = [];
  const name = c?.name?.trim();
  if (!name) faltantes.push('nombre o razón social');
  const tipoValido = Boolean(c?.docType && c.docType in DIAN_DOC_TYPES);
  if (!tipoValido) faltantes.push('tipo de documento');
  const numero = c?.idNumber?.replace(/\s/g, '');
  if (!numero) {
    faltantes.push('número de documento');
  } else if (
    c?.docType &&
    DOC_TYPES_NUMERICOS.includes(c.docType) &&
    !normalizarNumeroDocumento(c.docType, numero)
  ) {
    faltantes.push('número de documento (solo dígitos, sin ceros a la izquierda)');
  }
  if (c?.docType === '31' && numero) {
    const dvMsg = errorDvCliente({ dianDocType: '31', docNumber: numero, nitDv: c.nitDv });
    if (dvMsg) faltantes.push(dvMsg);
  }
  if (faltantes.length > 0 || !c) return { faltantes };

  // Con los datos mínimos completos, `buildAdquiriente` normaliza el número y
  // el DV igual que en la FEV; del resto de la ficha solo viaja lo que haya.
  return { adquiriente: buildAdquiriente(c), faltantes: [] };
}
