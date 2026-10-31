import { DIAN_DOC_TYPES, dvNitValido } from '../../../customers/domain/datos-fiscales';
import { CONSUMIDOR_FINAL_NIT } from '../einvoicing.constants';
import type { TipoAmbiente } from '../emisor-fiscal';
import { descuadresFactura, type ParteUbl } from './factura-ubl';
import {
  CONSUMIDOR_FINAL_UBL,
  emisorUbl,
  lineas,
  resolucion,
  totales,
  type DocumentoParaUbl,
  type EmisorParaUbl,
} from './factura-de-documento';
import { faltantesPos } from './pos-ubl';
import type { CamposPosDocumento, PagoPosUbl, PosUbl } from './pos-ubl.types';
import { assertTextoXml, DocumentoUblInvalidoError, municipioDaneValido } from './xml-ubl';

/**
 * Del documento POS guardado a la entrada de `armarPosUbl`. Como
 * `prepararFacturaUbl`: decide todo lo que puede impedir armar el XML y dice qué
 * corregir, ANTES de leer el PIN y de firmar.
 */

/** El documento `type: 'pos'` guardado: lo de la factura más la caja, el fabricante y los pagos. */
export type DocumentoPosParaUbl = DocumentoParaUbl & CamposPosDocumento;

/** El POS listo para el builder, salvo el código de seguridad (que necesita el PIN). */
export type PosSinCodigo = Omit<PosUbl, 'codigoSeguridadSoftware'>;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Adquiriente del POS. Sin datos: consumidor final (222222222222, tipo 13,
 * R-99-PN, tributo ZZ «No aplica»; §8.1 DEAK, se sigue la regla y no el ejemplo
 * oficial, que pone 01). Con datos, basta nombre, tipo y número de documento, y
 * DV si es NIT (art. 19 par. 1, Res. 165/2023): NO se exige la ficha fiscal
 * completa de la factura (`validarAdquirienteParaFactura` no aplica).
 */
function adquirientePos(doc: DocumentoPosParaUbl): ParteUbl {
  const a = doc.adquiriente;
  const numero = a?.docNumber?.trim();
  if (!numero || numero === CONSUMIDOR_FINAL_NIT) {
    return { ...CONSUMIDOR_FINAL_UBL, responsabilidades: [...CONSUMIDOR_FINAL_UBL.responsabilidades] };
  }
  const faltantes: string[] = [];
  const tipo = a?.docType?.trim() ?? '';
  if (!a?.name?.trim()) faltantes.push('nombre');
  if (!(tipo in DIAN_DOC_TYPES)) faltantes.push('tipo de documento');
  const esNit = tipo === '31';
  const dv = a?.nitDv?.trim();
  if (esNit && !dv) faltantes.push('DV del NIT');
  else if (esNit && !dvNitValido(numero, dv!)) faltantes.push('DV del NIT (no cuadra con el NIT)');
  if (faltantes.length > 0) {
    throw new DocumentoUblInvalidoError(
      `No se puede armar el documento POS: en los datos del cliente falta ${faltantes.join(', ')}.`,
    );
  }
  const responsable = a!.regimen === 'responsable_iva';
  const tipoPersona = a!.tipoPersona === '1' || a!.tipoPersona === '2' ? a!.tipoPersona : esNit ? '1' : '2';
  const direccion =
    municipioDaneValido(a!.municipioDane) && a!.address?.trim()
      ? { municipioDane: a!.municipioDane, linea: a!.address.trim() }
      : undefined;
  return {
    tipoPersona,
    tipoDocumento: tipo,
    numero,
    dv: esNit ? dv : undefined,
    nombre: a!.name!.trim(),
    responsabilidades: a!.responsabilidades?.length ? [...a!.responsabilidades] : ['R-99-PN'],
    listaResponsabilidades: responsable ? '48' : '49',
    tributo: responsable ? '01' : 'ZZ',
    direccion,
    email: a!.email?.trim() || undefined,
    telefono: a!.phone?.trim() || undefined,
  };
}

/** Los pagos guardados, normalizados; lo que no es válido lo rechaza `faltantesPos` o el esqueleto. */
function pagos(doc: DocumentoPosParaUbl): PagoPosUbl[] {
  if (!Array.isArray(doc.pagos)) return [];
  return doc.pagos.map((p, i) => {
    const forma = p?.formaPago?.trim();
    const medio = p?.medio?.trim() ?? '';
    const que = `pago ${i + 1}`;
    if (forma !== '1' && forma !== '2') {
      throw new DocumentoUblInvalidoError(`No se puede armar el documento POS: forma de pago inválida en el ${que}.`);
    }
    if (!/^[0-9A-Z]{1,3}$/.test(medio)) {
      throw new DocumentoUblInvalidoError(`No se puede armar el documento POS: medio de pago inválido en el ${que}.`);
    }
    const vence = p.vence?.trim() || undefined;
    if (vence !== undefined && !FECHA.test(vence)) {
      throw new DocumentoUblInvalidoError(`No se puede armar el documento POS: vencimiento inválido en el ${que}.`);
    }
    return { formaPago: forma, medio, vence };
  });
}

/**
 * Valida el documento POS y arma la entrada del builder. Lanza
 * `DocumentoUblInvalidoError` con lo que hay que corregir.
 *
 * El SoftwareID es el de factura (`facturaSoftwareId`): hoy `fiscal_emitters`
 * no separa un registro del POS (a confirmar en habilitación, §7.8 del anexo).
 */
export function prepararPosUbl(doc: DocumentoPosParaUbl, emisor: EmisorParaUbl): PosSinCodigo {
  if (doc.type !== 'pos') {
    throw new DocumentoUblInvalidoError(`Este builder arma documentos equivalentes POS, no «${doc.type}»`);
  }
  if (!doc.cufe) throw new DocumentoUblInvalidoError('El documento POS no tiene CUDE');
  if (doc.tipoAmbiente !== '1' && doc.tipoAmbiente !== '2') {
    throw new DocumentoUblInvalidoError('El documento POS no tiene el ambiente con el que se calculó su CUDE');
  }
  // Antes que nada, un texto que XML no admite es un 400 que dice el campo.
  assertTextoXml({ cajaVenta: doc.cajaVenta, fabricante: doc.fabricante, pagos: doc.pagos }, '');
  const totalesDoc = totales(doc);
  const lineasDoc = lineas(doc);
  const listaPagos = pagos(doc);
  const primero = listaPagos[0];
  const caja = doc.cajaVenta ?? {};
  const fab = doc.fabricante ?? {};
  const p: PosSinCodigo = {
    numero: doc.fullNumber,
    prefijo: doc.prefix || undefined,
    cufe: doc.cufe,
    fecha: doc.issueDate,
    hora: doc.issueTime,
    tipoAmbiente: doc.tipoAmbiente as TipoAmbiente,
    resolucion: resolucion(doc),
    softwareId: emisor.facturaSoftwareId?.trim() ?? '',
    emisor: emisorUbl(doc, emisor, lineasDoc),
    adquiriente: adquirientePos(doc),
    // Heredados de la factura: los del primer pago. El XML escribe `pagos`.
    formaPago: primero?.formaPago ?? '1',
    medioPago: primero?.medio ?? '',
    vencimiento: primero?.vence,
    lineas: lineasDoc,
    cargos: doc.charges ?? [],
    totales: totalesDoc,
    cajaVenta: {
      placa: caja.placa?.trim() ?? '',
      ubicacion: caja.ubicacion?.trim() ?? '',
      tipo: caja.tipo?.trim() ?? '',
      cajero: caja.cajero?.trim() ?? '',
      codigoVenta: caja.codigoVenta?.trim() ?? '',
    },
    fabricante: {
      nombreApellido: fab.nombreApellido?.trim() ?? '',
      razonSocial: fab.razonSocial?.trim() || undefined,
      nombreSoftware: fab.nombreSoftware?.trim() ?? '',
    },
    pagos: listaPagos,
  };
  assertTextoXml(p, '');
  const faltantes = faltantesPos(p);
  if (faltantes.length > 0) {
    throw new DocumentoUblInvalidoError(`No se puede armar el documento POS; falta: ${faltantes.join(', ')}.`);
  }
  const fallas = descuadresFactura(p);
  if (fallas.length > 0) throw new DocumentoUblInvalidoError(`El documento no cuadra: ${fallas.join('; ')}`);
  return p;
}
