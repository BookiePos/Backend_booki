import { buildAdquiriente, type ClienteVenta } from '../../adquiriente';
import { calcularCudePos } from '../../cufe';
import { documentoDeVenta, type VentaParaDocumento } from '../../documento-venta';
import type { DocumentoPosParaUbl } from '../pos-de-documento';
import type { CamposPosDocumento } from '../pos-ubl.types';
import { DV, NIT, PIN, documento } from './factura-de-prueba.test';

/**
 * Documentos POS de prueba (Fase 7A): la misma venta de la factura de prueba
 * con `type: 'pos'`, prefijo de POS, la caja, el fabricante y los pagos, y el
 * CUDE calculado con `calcularCudePos` (PIN), como en la emisión del POS.
 * Nada de esto es un dato real.
 */
export const CAJA = {
  placa: 'CAJA-01',
  ubicacion: 'Mostrador principal',
  tipo: 'Caja principal',
  cajero: 'Laura Gómez',
  codigoVenta: 'V-000123',
};

export const FABRICANTE = {
  nombreApellido: 'Samuel Múnera',
  razonSocial: 'BookiPos S.A.S.',
  nombreSoftware: 'BookiPos',
};

export function documentoPos(
  venta: VentaParaDocumento,
  o: {
    cliente?: ClienteVenta;
    pagos?: CamposPosDocumento['pagos'];
    numero?: number;
    ambiente?: '1' | '2';
    caja?: CamposPosDocumento['cajaVenta'];
    fabricante?: CamposPosDocumento['fabricante'];
  } = {},
): DocumentoPosParaUbl {
  const base = documento(venta, { cliente: o.cliente, numero: o.numero, ambiente: o.ambiente });
  const d = documentoDeVenta(venta);
  const numero = o.numero ?? 1;
  const fullNumber = `EPOS${numero}`;
  const cude = calcularCudePos({
    numero: fullNumber,
    fecha: base.issueDate,
    hora: base.issueTime,
    ...d.codigoUnico,
    nitEmisor: NIT,
    numAdquiriente: buildAdquiriente(o.cliente).docNumber,
    softwarePin: PIN,
    tipoAmbiente: base.tipoAmbiente as '1' | '2',
  });
  return {
    ...base,
    type: 'pos',
    prefix: 'EPOS',
    fullNumber,
    cufe: cude,
    formaPago: undefined,
    medioPago: undefined,
    resolution: {
      numero: '18760000001',
      prefijo: 'EPOS',
      rangoDesde: 1,
      rangoHasta: 1000,
      vigenciaDesde: new Date('2022-01-01'),
      vigenciaHasta: new Date('2030-01-01'),
    },
    cajaVenta: o.caja ?? { ...CAJA },
    fabricante: o.fabricante ?? { ...FABRICANTE },
    pagos: o.pagos ?? [{ formaPago: '1', medio: '10' }],
  };
}

export { DV, NIT };
