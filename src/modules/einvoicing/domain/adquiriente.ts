import {
  DIAN_DOC_TYPES,
  RESPONSABILIDADES_FISCALES,
  errorDvCliente,
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
    docNumber: esNit && nit ? nit.base : c.idNumber.replace(/\s/g, ''),
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
